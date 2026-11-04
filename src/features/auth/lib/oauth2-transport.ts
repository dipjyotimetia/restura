import {
  type DesktopTransportConfig,
  executeProxiedRequest,
  type ProxyJsonResponse,
} from '@/lib/shared/transport';

/**
 * `fetch`-shaped adapter that sends an OAuth2 token / device-authorization
 * request through the app's HTTP transport — the Worker's `/api/proxy` on web
 * and self-host, `http:request` IPC on desktop — instead of a direct renderer
 * fetch. That gives token requests the shared SSRF guard and outbound policy,
 * and frees them from CORS (most IdPs send no CORS headers) and from the
 * desktop renderer CSP (which blocks `http://localhost` IdPs).
 *
 * Redirects are not followed: a token endpoint that redirects would otherwise
 * re-POST the client secret to wherever it points.
 *
 * `desktopFor` gives the desktop transport settings (TLS verification, CA and
 * client certificates, proxy) for a token URL — the same ones the request the
 * token is for would use, so a private-CA or proxied IdP works like the API.
 */
export function createProxiedTokenFetch(
  desktopFor?: (url: string) => DesktopTransportConfig | undefined
): typeof globalThis.fetch {
  return (input, init) => sendTokenRequest(input, init, desktopFor);
}

/** Token fetch with the app-wide transport defaults (no per-request settings). */
export const proxiedTokenFetch: typeof globalThis.fetch = createProxiedTokenFetch();

async function sendTokenRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit = {},
  desktopFor?: (url: string) => DesktopTransportConfig | undefined
): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
    throw new TypeError('Token requests through the app transport need a string body');
  }
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const spec = {
    method: init.method ?? 'GET',
    url,
    headers,
    ...(typeof init.body === 'string' ? { bodyType: 'raw' as const, data: init.body } : {}),
    redirectPolicy: { maxRedirects: 0 },
  };
  const options = init.signal ? { signal: init.signal } : {};
  const desktop = desktopFor?.(url);
  const reply = desktop
    ? await executeProxiedRequest(spec, options, desktop)
    : await executeProxiedRequest(spec, options);
  return toResponse(reply);
}

function bodyText(reply: ProxyJsonResponse): string {
  const { data } = reply;
  if (data === undefined || data === null) return '';
  if (typeof data !== 'string') return JSON.stringify(data);
  if (reply.bodyEncoding !== 'base64') return data;
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toResponse(reply: ProxyJsonResponse): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(reply.headers ?? {})) {
    try {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    } catch {
      // A header the Fetch API refuses cannot matter to a token response.
    }
  }
  const nullBody = reply.status === 204 || reply.status === 205 || reply.status === 304;
  const status = reply.status >= 200 && reply.status <= 599 ? reply.status : 502;
  return new Response(nullBody ? null : bodyText(reply), {
    status,
    statusText: reply.statusText ?? '',
    headers,
  });
}
