/**
 * Buffered proxy transport with live body progress.
 *
 * Same contract as `executeProxiedRequest` — resolves to the buffered
 * `ProxyJsonResponse` — but on the web it reads the upstream body through the
 * Worker's streaming pass-through (`streamingMode`) and reports every chunk as
 * it arrives. Callers that can render partial results (GraphQL `@defer` /
 * `@stream` over `multipart/mixed`) use the chunks; everything downstream of
 * the executor (test scripts, history, cookies) still sees one complete
 * response.
 *
 * Desktop: Electron's HTTP IPC has no streaming channel, so this falls back to
 * the buffered IPC call and reports the whole body as a single chunk once it
 * arrives. See the `graphql.incrementalDelivery` capability.
 */
import { bytesToBase64, isBinaryContentType, readStreamToBytes } from '@shared/protocol/binary';
import {
  MAX_RESPONSE_SIZE,
  PROXY_CAPABILITY_HEADER,
  PROXY_STREAM_MARKER_HEADER,
} from '@shared/protocol/proxy-limits';
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import {
  decodeSetCookieSideChannel,
  SET_COOKIE_SIDE_CHANNEL_HEADER,
} from '@shared/protocol/set-cookie';
import { base64ToBytes } from '@/lib/shared/binaryBody';
import { isElectron } from '@/lib/shared/platform';
import {
  type DesktopTransportConfig,
  executeProxiedRequest,
  executeProxiedStreamingRequest,
  type ProxyJsonResponse,
  ProxyTransportError,
} from '@/lib/shared/transport';

export interface ResponseProgress {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The newly received bytes (decoded from base64 on the desktop fallback). */
  chunk: Uint8Array;
}

export type ResponseProgressHandler = (progress: ResponseProgress) => void;

function headerValue(headers: Record<string, string>, name: string): string {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return '';
}

function flatHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/**
 * A streamed reply is the proxy's own error only when the proxy says so: it
 * carries the capability header (so it is a current proxy) but not the
 * upstream-reply marker. The body is never inspected — an upstream may well
 * answer `{ "error": "…" }` itself. Without the capability header the proxy
 * predates the marker (version skew: a preview build against an older Worker,
 * or a rollback), the reply is ambiguous, and it is kept as the upstream's.
 */
function isProxyError(response: Response): boolean {
  return (
    response.headers.get(PROXY_CAPABILITY_HEADER) !== null &&
    response.headers.get(PROXY_STREAM_MARKER_HEADER) === null
  );
}

/** Proxy-generated error bodies are small JSON; never read more than this. */
const MAX_PROXY_ERROR_BYTES = 64 * 1024;

async function readProxyError(response: Response): Promise<ProxyTransportError> {
  let message = `Proxy request failed (${response.status})`;
  try {
    const bytes = response.body
      ? await readStreamToBytes(response.body, MAX_PROXY_ERROR_BYTES)
      : new Uint8Array();
    const payload = bytes
      ? (JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown })
      : null;
    if (payload && typeof payload.error === 'string') message = payload.error;
  } catch {
    // Not JSON — keep the generic message.
  }
  return new ProxyTransportError(message, response.status);
}

export async function executeProxiedRequestWithProgress(
  spec: ProxyRequestBody,
  onProgress: ResponseProgressHandler,
  options: { signal?: AbortSignal } = {},
  desktop?: DesktopTransportConfig
): Promise<ProxyJsonResponse> {
  if (isElectron()) {
    const buffered = await executeProxiedRequest(spec, options, desktop);
    const body = typeof buffered.data === 'string' ? buffered.data : '';
    const chunk =
      buffered.bodyEncoding === 'base64' ? base64ToBytes(body) : new TextEncoder().encode(body);
    onProgress({
      status: buffered.status,
      statusText: buffered.statusText,
      headers: flatHeaders(buffered.headers),
      chunk,
    });
    return buffered;
  }

  let response: Response;
  try {
    response = await executeProxiedStreamingRequest(
      { ...spec, streamingMode: true },
      options.signal ? { signal: options.signal } : {}
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ProxyTransportError(err instanceof Error ? err.message : 'Proxy request failed');
  }
  if (isProxyError(response)) {
    throw await readProxyError(response);
  }

  const setCookies = decodeSetCookieSideChannel(
    response.headers.get(SET_COOKIE_SIDE_CHANNEL_HEADER)
  );
  const headers: Record<string, string> = {};
  for (const [k, v] of response.headers.entries()) {
    if (
      k === SET_COOKIE_SIDE_CHANNEL_HEADER ||
      k === PROXY_STREAM_MARKER_HEADER ||
      k === PROXY_CAPABILITY_HEADER
    ) {
      continue;
    }
    headers[k] = v;
  }
  const meta = { status: response.status, statusText: response.statusText, headers };

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    let finished = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          break;
        }
        size += value.byteLength;
        if (size > MAX_RESPONSE_SIZE) {
          throw new ProxyTransportError(
            `Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`,
            413
          );
        }
        chunks.push(value);
        onProgress({ ...meta, chunk: value });
      }
    } finally {
      // Any throw (size cap, a failing progress sink, a read error) must tear
      // down the upstream body, not just release the lock and leave it open.
      if (!finished) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  // Mirror the buffered Worker reply: binary content types travel as base64.
  const binary = size > 0 && isBinaryContentType(headerValue(headers, 'content-type'));
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(setCookies.length > 0 ? { setCookies } : {}),
    data: binary ? bytesToBase64(bytes) : new TextDecoder().decode(bytes),
    size,
    ...(binary ? { bodyEncoding: 'base64' as const } : {}),
  };
}
