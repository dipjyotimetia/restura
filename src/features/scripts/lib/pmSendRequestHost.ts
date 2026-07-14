/**
 * Renderer-side host bridge for `pm.sendRequest`. Converts the
 * sandboxed `PmSendRequestInput` shape into a `ProxyRequestBody` and
 * fires it through the same `executeProxiedRequest` path a top-level
 * send uses — so SSRF guards, header policy, and auth all apply.
 *
 * Two behaviours that match Postman v12 semantics and weren't in v1
 * of this file:
 *  - Variable substitution: `{{var}}` references inside the URL,
 *    header values, and string body are resolved against the same
 *    `envVars` map the parent request used. Captured at construction
 *    via the `resolveVars` closure so a single sub-request only sees
 *    one consistent snapshot.
 *  - Header inheritance: the parent request's *outgoing* headers
 *    (Authorization, X-API-Key, etc. — the result of running the
 *    auth descriptor against the URL) are merged in as defaults.
 *    User-supplied headers in the sendRequest input win on collision.
 *    Matches Newman's behaviour where sub-requests inside a script
 *    pick up the collection-level auth automatically.
 *
 * Returned to the executor's `host.sendRequest` slot; the executor's
 * `pm.sendRequest` native binding wraps the response in a Postman-shaped
 * object inside QuickJS.
 */
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import { injectString } from '@/features/workflows/lib/variableHelpers';
import { executeProxiedRequest } from '@/lib/shared/transport';
import type { PmSendRequestInput, PmSubResponse } from './scriptExecutor';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function inferBody(body: unknown): { bodyType?: ProxyRequestBody['bodyType']; data?: string } {
  if (body == null) return {};
  if (typeof body === 'string') {
    // Heuristic: looks like JSON → tag as application/json so the
    // downstream proxy serializes appropriately. The user can always
    // pass an explicit Content-Type header to override.
    const trimmed = body.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return { bodyType: 'json', data: body };
    }
    return { bodyType: 'raw', data: body };
  }
  if (typeof body === 'object') {
    return { bodyType: 'json', data: JSON.stringify(body) };
  }
  return { bodyType: 'raw', data: String(body) };
}

export interface MakeRendererSendRequestOptions {
  /** Live variable map (env + collection + iteration row, merged). */
  variables?: Record<string, string>;
  /**
   * Default headers inherited by sub-requests — typically the parent
   * request's outgoing headers (auth + content-type). User-supplied
   * headers in `pm.sendRequest(input)` win on collision.
   */
  inheritedHeaders?: Record<string, string>;
  /**
   * Parent abort signal. A user-cancelled top-level send also cancels
   * any in-flight `pm.sendRequest` sub-requests.
   */
  signal?: AbortSignal;
}

function resolveAll(
  obj: Record<string, string> | undefined,
  resolve: (s: string) => string
): Record<string, string> {
  if (!obj) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolve(v);
  return out;
}

/**
 * Build the renderer's `host.sendRequest` closure. Captures the
 * variable map, inherited headers, and abort signal once so every
 * sub-request fired from a single script eval sees the same snapshot.
 */
export function makeRendererSendRequest(
  options: MakeRendererSendRequestOptions = {}
): (input: PmSendRequestInput) => Promise<PmSubResponse> {
  const variables = options.variables ?? {};
  const inherited = options.inheritedHeaders ?? {};
  const resolve = (s: string): string => injectString(s, variables);

  return async (input) => {
    const method = (input.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`pm.sendRequest: method ${method} is not allowed`);
    }
    // Merge order: inherited (lowest), user-supplied (highest). Resolve
    // {{var}} on both sides; the user's literal `"Bearer {{token}}"` is
    // legitimate Postman idiom.
    const mergedHeaders: Record<string, string> = {
      ...resolveAll(inherited, resolve),
      ...resolveAll(input.headers, resolve),
    };
    const bodyShape = inferBody(typeof input.body === 'string' ? resolve(input.body) : input.body);
    const spec: ProxyRequestBody = {
      url: resolve(input.url),
      method,
      headers: mergedHeaders,
      ...(bodyShape.bodyType !== undefined && { bodyType: bodyShape.bodyType }),
      ...(bodyShape.data !== undefined && { data: bodyShape.data }),
    };
    const started = Date.now();
    const proxy = await executeProxiedRequest(
      spec,
      options.signal ? { signal: options.signal } : {}
    );
    const bodyString = typeof proxy.data === 'string' ? proxy.data : JSON.stringify(proxy.data);
    return {
      code: proxy.status,
      status: proxy.statusText ?? '',
      headers: proxy.headers as Record<string, string>,
      body: bodyString,
      responseTime: Date.now() - started,
      responseSize: proxy.size ?? bodyString.length,
    };
  };
}
