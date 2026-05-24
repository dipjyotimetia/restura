import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { BodyType as ProtocolBodyType } from '@shared/protocol/body-builder';
import type { HttpRequest, BodyType, AuthConfig } from '@/types';
import type { ProtocolAuthConfig, ProtocolAuthType } from '@shared/protocol/types';
import { undiciFetcher } from '../undiciFetcher';
import { resolveVarsDeep } from '../varResolver';
import type { LoadedRequest } from '../collectionLoader';
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

  // Auth that the renderer normally applies before hitting the proxy. Bearer
  // / Basic / API-key / OAuth2 are header-only and trivial to apply here; we
  // do not refresh OAuth2 tokens (no UI/keychain in CI).
  applyAuthHeaders(req.auth, headers, params);

  const built = buildBody(req.body, opts.vars);
  const proxyAuth = toProtocolAuth(req.auth);

  const start = Date.now();
  try {
    const result = await executeHttpProxy(
      {
        method: req.method,
        url,
        headers,
        params,
        ...(built.bodyType !== 'none' ? { bodyType: built.bodyType } : {}),
        ...(built.data !== undefined ? { data: built.data } : {}),
        timeout: opts.timeoutMs,
        ...(proxyAuth ? { auth: proxyAuth } : {}),
      },
      undiciFetcher,
      { allowLocalhost: opts.allowLocalhost }
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
}

function buildBody(
  body: HttpRequest['body'] | undefined,
  vars: Record<string, string>
): BuiltBody {
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
    case 'x-www-form-urlencoded':
      return { bodyType: 'form-urlencoded', ...(raw !== undefined ? { data: raw } : {}) };
    case 'binary':
      // body.raw is expected to be base64-encoded payload.
      return { bodyType: 'binary', ...(raw !== undefined ? { data: raw } : {}) };
    case 'form-data':
    case 'multipart-mixed':
    case 'protobuf':
      // Not supported in CLI v0.2 — fall back to raw if present, otherwise none.
      return raw !== undefined
        ? { bodyType: 'raw', data: raw }
        : { bodyType: 'none' };
  }
}

function applyAuthHeaders(
  auth: AuthConfig | undefined,
  headers: Record<string, string>,
  params: Record<string, string>
): void {
  if (!auth || auth.type === 'none') return;
  switch (auth.type) {
    case 'bearer': {
      const token = secretString(auth.bearer?.token);
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return;
    }
    case 'basic': {
      const username = auth.basic?.username ?? '';
      const password = secretString(auth.basic?.password) ?? '';
      const encoded = Buffer.from(`${username}:${password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      return;
    }
    case 'api-key': {
      const key = auth.apiKey?.key;
      const value = secretString(auth.apiKey?.value);
      if (!key || !value) return;
      if (auth.apiKey?.in === 'query') params[key] = value;
      else headers[key] = value;
      return;
    }
    case 'oauth2': {
      const token = secretString(auth.oauth2?.accessToken);
      if (token) {
        const tokenType = auth.oauth2?.tokenType ?? 'Bearer';
        headers['Authorization'] = `${tokenType} ${token}`;
      }
      return;
    }
    // aws-signature, oauth1, ntlm, wsse are sign-at-wire — handled by toProtocolAuth.
  }
}

function secretString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const r = v as { kind?: string; value?: string };
    if (r.kind === 'inline' && typeof r.value === 'string') return r.value;
    // 'handle' refs are desktop-only — not resolvable in CLI; warn via stderr.
    if (r.kind === 'handle') {
      process.stderr.write(
        '[restura] WARNING: a secret handle ref is unresolvable in CLI; ignoring.\n'
      );
    }
  }
  return undefined;
}

function toProtocolAuth(auth: AuthConfig | undefined): ProtocolAuthConfig | undefined {
  if (!auth) return undefined;
  const wireTypes: ProtocolAuthType[] = ['aws-signature', 'oauth1', 'ntlm', 'wsse'];
  if (!wireTypes.includes(auth.type as ProtocolAuthType)) return undefined;
  const out: ProtocolAuthConfig = { type: auth.type as ProtocolAuthType };
  if (auth.awsSignature) {
    out.awsSignature = {
      accessKey: auth.awsSignature.accessKey,
      secretKey: secretString(auth.awsSignature.secretKey) ?? '',
      region: auth.awsSignature.region,
      service: auth.awsSignature.service,
    };
  }
  if (auth.oauth1) {
    out.oauth1 = {
      consumerKey: auth.oauth1.consumerKey,
      consumerSecret: secretString(auth.oauth1.consumerSecret) ?? '',
      ...(auth.oauth1.accessToken !== undefined
        ? { accessToken: secretString(auth.oauth1.accessToken) ?? '' }
        : {}),
      ...(auth.oauth1.accessTokenSecret !== undefined
        ? { accessTokenSecret: secretString(auth.oauth1.accessTokenSecret) ?? '' }
        : {}),
      ...(auth.oauth1.signatureMethod ? { signatureMethod: auth.oauth1.signatureMethod } : {}),
      ...(auth.oauth1.realm ? { realm: auth.oauth1.realm } : {}),
      ...(auth.oauth1.nonce ? { nonce: auth.oauth1.nonce } : {}),
      ...(auth.oauth1.timestamp ? { timestamp: auth.oauth1.timestamp } : {}),
      ...(auth.oauth1.addParamsToBody !== undefined
        ? { addParamsToBody: auth.oauth1.addParamsToBody }
        : {}),
    };
  }
  if (auth.ntlm) {
    out.ntlm = {
      username: auth.ntlm.username,
      password: secretString(auth.ntlm.password) ?? '',
      ...(auth.ntlm.domain ? { domain: auth.ntlm.domain } : {}),
      ...(auth.ntlm.workstation ? { workstation: auth.ntlm.workstation } : {}),
    };
  }
  if (auth.wsse) {
    out.wsse = {
      username: auth.wsse.username,
      password: secretString(auth.wsse.password) ?? '',
      ...(auth.wsse.passwordType ? { passwordType: auth.wsse.passwordType } : {}),
    };
  }
  return out;
}
