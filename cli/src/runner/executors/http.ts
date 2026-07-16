import type { FormField, ProxyBodyType as ProtocolBodyType } from '@shared/protocol/body-builder';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { RedirectPolicy } from '@shared/protocol/types';
import type { BodyType, FormDataItem, HttpRequest } from '@/types';
import type { LoadedRequest } from '../collectionLoader';
import { createUndiciFetcher, undiciFetcher } from '../undiciFetcher';
import { resolveVarsDeep } from '../varResolver';
import { applyAuthHeaders, resolveOAuth2Token, toProtocolAuth } from './auth';
import type { ExecuteOptions, ExecuteOutcome } from './types';

/**
 * HTTP + GraphQL executor. GraphQL is represented internally as an HttpRequest
 * with `body.type === 'graphql'` (see `ocToInternal`), so the same code path
 * serves both. Auth that needs wire-level signing (AWS SigV4, OAuth1, WSSE,
 * NTLM) is forwarded to `executeHttpProxy` which delegates to `auth-signer`.
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
  const req = item.request as HttpRequest;

  const url = resolveVarsDeep(req.url, opts.vars);
  const headers: Record<string, string> = {};
  for (const h of req.headers) {
    if (h.enabled && h.key) headers[h.key] = resolveVarsDeep(h.value, opts.vars);
  }
  const params: Record<string, string> = {};
  for (const p of req.params) {
    if (p.enabled && p.key) params[p.key] = resolveVarsDeep(p.value, opts.vars);
  }

  const built = buildBody(req.body, opts.vars);

  const start = Date.now();
  try {
    // Auth that the renderer normally applies before hitting the proxy. Bearer
    // / Basic / API-key / OAuth2 are header-only; AWS SigV4 / OAuth1 / WSSE are
    // signed at the wire by executeHttpProxy. Resolved here (inside the try) so
    // an unresolvable secret-handle ref surfaces as an errored outcome.
    // Acquire an OAuth2 client_credentials token when the auth declares a token
    // endpoint but carries no access token (e.g. a CI collection). No-op for
    // every other auth type.
    const resolvedAuth = await resolveOAuth2Token(req.auth, opts.vars, {
      allowLocalhost: opts.allowLocalhost,
    });
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

    const fetcher = opts.dispatcher ? createUndiciFetcher(opts.dispatcher) : undiciFetcher;
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

interface BuiltBody {
  bodyType: ProtocolBodyType | 'none';
  data?: string;
  formData?: FormField[];
}

function buildBody(body: HttpRequest['body'] | undefined, vars: Record<string, string>): BuiltBody {
  if (!body || body.type === 'none') return { bodyType: 'none' };
  const raw = body.raw !== undefined ? resolveVarsDeep(body.raw, vars) : undefined;

  // Map internal BodyType → shared/protocol BodyType. The shared union is
  // narrower; anything outside it is encoded as 'raw' with a content-type
  // hint set in headers separately if needed.
  const t: BodyType = body.type;
  switch (t) {
    case 'json':
      return { bodyType: 'json', ...(raw !== undefined ? { data: raw } : {}) };
    case 'text':
      return { bodyType: 'text', ...(raw !== undefined ? { data: raw } : {}) };
    case 'graphql':
      // GraphQL is just JSON over HTTP — body.raw already holds the stringified
      // { query, variables, operationName } payload.
      return { bodyType: 'json', ...(raw !== undefined ? { data: raw } : {}) };
    case 'xml':
      // 'raw' bodyType emits with no content-type. The header layer should set
      // application/xml if the caller wants it; we don't force it here.
      return { bodyType: 'raw', ...(raw !== undefined ? { data: raw } : {}) };
    case 'x-www-form-urlencoded': {
      // OpenCollection exports carry urlencoded forms as a structured field
      // array (no `raw`); legacy collections may carry a pre-encoded `raw`.
      const fields = mapFormFields(body.formData, vars);
      if (fields.length > 0) return { bodyType: 'form-urlencoded', formData: fields };
      return { bodyType: 'form-urlencoded', ...(raw !== undefined ? { data: raw } : {}) };
    }
    case 'binary':
      // body.raw is expected to be base64-encoded payload.
      return { bodyType: 'binary', ...(raw !== undefined ? { data: raw } : {}) };
    case 'form-data':
      // Structured multipart: text fields + file parts (base64 content). The
      // shared body-builder turns these into a FormData; the CLI fetcher
      // serialises that to multipart bytes.
      return { bodyType: 'form-data', formData: mapMultipartFields(body.formData, vars) };
    case 'multipart-mixed':
    case 'protobuf':
      // multipart-mixed / protobuf bodies aren't supported by the CLI fetcher —
      // fall back to raw if present, otherwise none.
      return raw !== undefined ? { bodyType: 'raw', data: raw } : { bodyType: 'none' };
  }
}

/**
 * Map internal multipart fields → shared `FormField[]`. Text fields are
 * var-resolved; file parts carry base64 content (left as-is) plus filename +
 * content-type so the shared builder/fetcher emit a correct multipart part.
 */
function mapMultipartFields(
  items: FormDataItem[] | undefined,
  vars: Record<string, string>
): FormField[] {
  if (!items) return [];
  const out: FormField[] = [];
  for (const item of items) {
    if (item.enabled === false || !item.key) continue;
    if (item.type === 'file') {
      out.push({
        name: resolveVarsDeep(item.key, vars),
        value: item.value,
        filename: item.fileName ?? 'file',
        ...(item.contentType ? { contentType: item.contentType } : {}),
      });
    } else {
      out.push({
        name: resolveVarsDeep(item.key, vars),
        value: resolveVarsDeep(item.value, vars),
      });
    }
  }
  return out;
}

/** Map internal text form fields → shared `FormField[]`, resolving vars and
 *  dropping disabled / file parts (the CLI fetcher can't read files). */
function mapFormFields(
  items: FormDataItem[] | undefined,
  vars: Record<string, string>
): FormField[] {
  if (!items) return [];
  const out: FormField[] = [];
  for (const item of items) {
    if (item.enabled === false || !item.key || item.type === 'file') continue;
    out.push({
      name: resolveVarsDeep(item.key, vars),
      value: resolveVarsDeep(item.value, vars),
    });
  }
  return out;
}
