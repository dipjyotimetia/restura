import { resolveAuthVariables } from '@shared/auth/resolve-variables';
import { buildGraphQLWireRequest, graphqlEnvelopeFromBody } from '@shared/graphql/wire';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import {
  applyBodyDefaultHeaders,
  authHeaderNames,
  buildProxyBody,
  collectEnabledRows,
  type ProxyBody,
} from '@shared/protocol/request-spec';
import type { RedirectPolicy } from '@shared/protocol/types';
import type { HttpRequest, KeyValue } from '@shared/types';
import type { LoadedRequest } from '../collectionLoader';
import { createUndiciFetcher, undiciFetcher } from '../undiciFetcher';
import { resolveVarsDeep } from '../varResolver';
import { applyAuthHeaders, resolveOAuth2Token, toProtocolAuth } from './auth';
import { materializeExternalSecretsInAuth } from './external-secret-materializer';
import type { ExecuteOptions, ExecuteOutcome } from './types';

/**
 * HTTP + GraphQL executor. GraphQL is represented internally as an HttpRequest
 * with `body.type === 'graphql'` (see `ocToInternal`), so the same code path
 * serves both. Auth that needs wire-level signing (AWS SigV4, OAuth1, WSSE,
 * Digest) is forwarded to `executeHttpProxy`; NTLM is refused (desktop-only).
 * Renderer-applied auth (Bearer, Basic, API-key, OAuth2) is materialised
 * here into headers/query params before the call.
 */
export async function executeHttp(
  item: LoadedRequest,
  opts: ExecuteOptions
): Promise<ExecuteOutcome> {
  if (item.type !== 'http') {
    return errorOutcome(`HTTP executor received non-http request: ${item.type}`);
  }
  // Refused at load time (e.g. a Postman auth type the CLI cannot sign): never
  // sent, from any entry point (collection runner, OWS workflows, agent tools).
  if (item.blocked) return errorOutcome(item.blocked);
  let req = item.request as HttpRequest;

  // GraphQL: shape the wire request exactly as the app does (shared
  // `buildGraphQLWireRequest`) — spec Accept header, and for GET the query /
  // variables / operationName / extensions move into URL params (#1109).
  let graphqlBuilt: ProxyBody | undefined;
  const preResolvedParams = new Set<KeyValue>();
  if (req.body.type === 'graphql') {
    const shaped = shapeGraphQL(req, opts.vars);
    if (!shaped.ok) return errorOutcome(shaped.error);
    req = shaped.request;
    graphqlBuilt = shaped.built;
    for (const p of shaped.addedParams) preResolvedParams.add(p);
  }

  const url = resolveVarsDeep(req.url, opts.vars);
  const resolve = (text: string) => resolveVarsDeep(text, opts.vars);
  const headers = applyBodyDefaultHeaders(
    req.body.type,
    collectEnabledRows(req.headers, (h) => resolve(h.value))
  );
  // GraphQL GET params were built from already-resolved values; resolving
  // them again would re-expand `{{…}}` text inside the resolved document.
  const params = collectEnabledRows(req.params, (p) =>
    preResolvedParams.has(p) ? p.value : resolve(p.value)
  );

  // CLI-only, kept deliberately: a form field name and a binary body may hold a
  // `{{var}}` (the app sends the name as written and treats binary as bytes).
  const built =
    graphqlBuilt ??
    buildProxyBody(req.body, { resolve, resolveFieldName: resolve, resolveBinary: resolve });

  const start = Date.now();
  try {
    const fetcher =
      opts.fetcher ?? (opts.dispatcher ? createUndiciFetcher(opts.dispatcher) : undiciFetcher);
    // Auth that the renderer normally applies before hitting the proxy. Bearer
    // / Basic / API-key / OAuth2 are header-only; AWS SigV4 / OAuth1 / WSSE are
    // signed at the wire by executeHttpProxy. Resolved here (inside the try) so
    // an unresolvable secret-handle ref surfaces as an errored outcome.
    // Acquire an OAuth2 client_credentials token when the auth declares a token
    // endpoint but carries no access token (e.g. a CI collection). No-op for
    // every other auth type.
    // `{{vars}}` resolve in every auth type first (same shared field map as the
    // app), so external-secret plaintext is never itself template-expanded.
    const varResolvedAuth = req.auth
      ? resolveAuthVariables(req.auth, (text) => resolveVarsDeep(text, opts.vars))
      : req.auth;
    const externalMaterializedAuth = await materializeExternalSecretsInAuth(
      varResolvedAuth,
      opts.externalSecretResolver
    );
    const resolvedAuth = await resolveOAuth2Token(externalMaterializedAuth, opts.vars, {
      allowLocalhost: opts.allowLocalhost,
      ...(opts.oauthFetch ? { fetch: opts.oauthFetch } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    // NTLM needs the desktop fetcher's pinned-connection handshake (#1069);
    // refuse rather than send the request unauthenticated.
    if (resolvedAuth?.type === 'ntlm') {
      return errorOutcome('NTLM authentication is desktop-only; the CLI cannot send this request');
    }
    applyAuthHeaders(resolvedAuth, headers, params);
    const proxyAuth = toProtocolAuth(resolvedAuth);

    // Per-request settings (legacy collections carry these) override the global
    // flags. Mirrors the desktop renderer's settings→spec mapping in
    // `src/features/http/lib/requestExecutor.ts`: redirect knobs are emitted
    // only when set. `followRedirects:false` maps to `maxRedirects:0`, which the
    // shared redirect-follower honours as "return the 3xx unfollowed".
    const settings = req.settings;
    const redirectPolicy: RedirectPolicy = {};
    if (settings?.followOriginalMethod !== undefined)
      redirectPolicy.followOriginalMethod = settings.followOriginalMethod;
    if (settings?.followAuthHeader !== undefined)
      redirectPolicy.followAuthHeader = settings.followAuthHeader;
    if (settings?.stripReferer !== undefined) redirectPolicy.stripReferer = settings.stripReferer;
    if (settings?.followRedirects === false) {
      redirectPolicy.maxRedirects = 0;
    } else if (settings?.maxRedirects !== undefined) {
      redirectPolicy.maxRedirects = settings.maxRedirects;
    }
    const authHeaders = authHeaderNames(resolvedAuth);
    if (authHeaders.length > 0) redirectPolicy.stripOnOriginChange = authHeaders;

    const result = await executeHttpProxy(
      {
        method: req.method,
        url,
        headers,
        params,
        ...(built.bodyType !== 'none' ? { bodyType: built.bodyType } : {}),
        ...(built.data !== undefined ? { data: built.data } : {}),
        ...(built.formData !== undefined ? { formData: built.formData } : {}),
        // Per-request timeout overrides the global --timeout; falls back to it.
        timeout: settings?.timeout ?? opts.timeoutMs,
        ...(proxyAuth ? { auth: proxyAuth } : {}),
        ...(Object.keys(redirectPolicy).length > 0 ? { redirectPolicy } : {}),
        ...(settings?.encodeUrlAutomatically !== undefined
          ? { encodeUrl: settings.encodeUrlAutomatically }
          : {}),
      },
      fetcher,
      {
        allowLocalhost: opts.allowLocalhost,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }
    );
    const durationMs = Date.now() - start;

    if (result.ok) {
      const passed = result.response.status >= 200 && result.response.status < 300;
      return {
        status: result.response.status,
        passed,
        durationMs,
        bodyBytes: result.response.size,
        responseHeaders: result.response.headers,
        ...(result.response.setCookies ? { setCookies: result.response.setCookies } : {}),
        responseBody: result.response.body,
      };
    }
    return {
      status: result.status,
      passed: false,
      durationMs,
      bodyBytes: 0,
      errorMessage: result.payload.error,
    };
  } catch (err) {
    return {
      status: 0,
      passed: false,
      durationMs: Date.now() - start,
      bodyBytes: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function errorOutcome(msg: string): ExecuteOutcome {
  return {
    status: 0,
    passed: false,
    durationMs: 0,
    bodyBytes: 0,
    errorMessage: msg,
  };
}

type ShapedGraphQL =
  | { ok: true; request: HttpRequest; built: ProxyBody; addedParams: KeyValue[] }
  | { ok: false; error: string };

/**
 * Resolve `{{vars}}` in the GraphQL document + variables, build the envelope
 * (stored envelope, or the document via the shared envelope builder) and shape
 * it for the wire with the same builder the app uses. GET refuses mutations /
 * subscriptions (spec-unsafe) before anything is sent.
 */
function shapeGraphQL(req: HttpRequest, vars: Record<string, string>): ShapedGraphQL {
  const body = req.body;
  const resolvedBody: HttpRequest['body'] = {
    ...body,
    ...(body.raw !== undefined ? { raw: resolveVarsDeep(body.raw, vars) } : {}),
    ...(body.graphqlVariables !== undefined
      ? { graphqlVariables: resolveVarsDeep(body.graphqlVariables, vars) }
      : {}),
  };
  const wire = buildGraphQLWireRequest(req, graphqlEnvelopeFromBody(resolvedBody));
  if (!wire.ok) return wire;
  const existing = new Set(req.params);
  const addedParams = wire.request.params.filter((p) => !existing.has(p));
  const built: ProxyBody =
    wire.method === 'GET'
      ? { bodyType: 'none' }
      : {
          bodyType: 'json',
          ...(wire.request.body.raw !== undefined ? { data: wire.request.body.raw } : {}),
        };
  return { ok: true, request: wire.request, built, addedParams };
}
