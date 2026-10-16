/**
 * RFC 6455 control-frame limits shared by the renderer (UI validation, browser
 * `WebSocket.close`) and the Electron IPC validators (`ws:disconnect`,
 * `ws:ping`). Backend-agnostic.
 *
 * Close codes: a client may only *send* 1000 (normal closure) or an
 * application/library code in 3000-4999 (§7.4.2) — the same set the browser
 * `WebSocket.close()` accepts, so web and desktop behave identically.
 * Control-frame payloads are capped at 125 bytes (§5.5); a close frame spends
 * two of those on the status code, leaving 123 bytes of UTF-8 reason.
 */

export const WS_DEFAULT_CLOSE_CODE = 1000;
export const WS_MAX_CLOSE_REASON_BYTES = 123;
export const WS_MAX_PING_PAYLOAD_BYTES = 125;

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

export function isSendableCloseCode(code: number): boolean {
  return Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999));
}

/** Returns a human-readable error, or null when the close frame is valid. */
export function closeFrameError(
  code: number | undefined,
  reason: string | undefined
): string | null {
  if (code === undefined) {
    return reason ? 'A close reason requires a close code' : null;
  }
  if (!isSendableCloseCode(code)) return 'Close code must be 1000 or 3000-4999';
  if (reason !== undefined && utf8ByteLength(reason) > WS_MAX_CLOSE_REASON_BYTES) {
    return `Close reason must be at most ${WS_MAX_CLOSE_REASON_BYTES} bytes (UTF-8)`;
  }
  return null;
}

/** Returns a human-readable error, or null when the ping payload fits a control frame. */
export function pingPayloadError(payload: string): string | null {
  return utf8ByteLength(payload) > WS_MAX_PING_PAYLOAD_BYTES
    ? `Ping payload must be at most ${WS_MAX_PING_PAYLOAD_BYTES} bytes (UTF-8)`
    : null;
}
