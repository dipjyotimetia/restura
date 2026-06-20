import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { ProxyBodyType as ProtocolBodyType } from '@shared/protocol/body-builder';
import type { FormField } from '@shared/protocol/body-builder';
import type { HttpRequest, BodyType, FormDataItem } from '@/types';
import { undiciFetcher } from '../undiciFetcher';
import { resolveVarsDeep } from '../varResolver';
import type { LoadedRequest } from '../collectionLoader';
import type { ExecuteOptions, ExecuteOutcome } from './types';
import { applyAuthHeaders, toProtocolAuth } from './auth';

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
    applyAuthHeaders(req.auth, headers, params);
    const proxyAuth = toProtocolAuth(req.auth);

    const result = await executeHttpProxy(
      {
        method: req.method,
        url,
        headers,
        params,
        ...(built.bodyType !== 'none' ? { bodyType: built.bodyType } : {}),
        ...(built.data !== undefined ? { data: built.data } : {}),
        ...(built.formData !== undefined ? { formData: built.formData } : {}),
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
    case 'multipart-mixed':
    case 'protobuf':
      // multipart/protobuf bodies are not supported by the CLI fetcher yet —
      // fall back to raw if present, otherwise none.
      return raw !== undefined ? { bodyType: 'raw', data: raw } : { bodyType: 'none' };
  }
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
