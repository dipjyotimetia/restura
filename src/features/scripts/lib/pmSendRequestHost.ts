/**
 * Renderer-side host bridge for `pm.sendRequest`. Converts the
 * sandboxed `PmSendRequestInput` shape into a `ProxyRequestBody` and
 * fires it through the same `executeProxiedRequest` path a top-level
 * send uses — so SSRF guards, header policy, and auth all apply.
 *
 * Returned to the executor's `host.sendRequest` slot; the executor's
 * `pm.sendRequest` native binding wraps the response in a Postman-shaped
 * object inside QuickJS.
 */
import { executeProxiedRequest } from '@/lib/shared/transport';
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
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

/**
 * Build the renderer's `host.sendRequest` closure. Captures the abort
 * signal from the parent request so a user-cancelled top-level send
 * also cancels any in-flight `pm.sendRequest` sub-requests.
 */
export function makeRendererSendRequest(
  signal?: AbortSignal
): (input: PmSendRequestInput) => Promise<PmSubResponse> {
  return async (input) => {
    const method = (input.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`pm.sendRequest: method ${method} is not allowed`);
    }
    const bodyShape = inferBody(input.body);
    const spec: ProxyRequestBody = {
      url: input.url,
      method,
      headers: input.headers ?? {},
      ...(bodyShape.bodyType !== undefined && { bodyType: bodyShape.bodyType }),
      ...(bodyShape.data !== undefined && { data: bodyShape.data }),
    };
    const started = Date.now();
    const proxy = await executeProxiedRequest(spec, signal ? { signal } : {});
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
