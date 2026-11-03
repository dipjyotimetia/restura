/**
 * WebSocket relay helpers shared by the Cloudflare and Node relays. Runtime
 * neutral: no `ws` or `cloudflare:` imports.
 */

/** RFC 6455 §5.5: a close frame's reason is at most 123 UTF-8 bytes. */
const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Map a close code received from one side to one the other side may send.
 * 1004/1005/1006/1015 (and anything outside 1000–1014 / 3000–4999) can be
 * observed but never sent: `ws` throws TypeError and workerd rejects them, and
 * a swallowed throw leaves the peer open. Such codes relay as 1000. Shared by
 * the Cloudflare and Node relays.
 */
export function relayCloseCode(code: number): number {
  const sendable =
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}

/**
 * Truncate a close reason to ≤123 UTF-8 bytes (longer makes close() throw)
 * without splitting a character. O(n) over the string, no allocation unless
 * it truncates. A lone surrogate counts as its 3-byte U+FFFD replacement.
 */
export function closeReason(text: string): string {
  // Every UTF-16 unit encodes to at most 3 bytes.
  if (text.length * 3 <= MAX_CLOSE_REASON_BYTES) return text;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    let size = unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    let units = 1;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        size = 4;
        units = 2;
      }
    }
    if (bytes + size > MAX_CLOSE_REASON_BYTES) return text.slice(0, i);
    bytes += size;
    i += units - 1;
  }
  return text;
}

/** Message of an unknown thrown value, for a close reason or log line. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
