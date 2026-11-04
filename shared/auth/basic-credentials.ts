import { bytesToBase64, utf8 } from '../protocol/crypto-utils';

/**
 * Encode `user:password` for an HTTP Basic `Authorization` header as base64
 * of its UTF-8 bytes (RFC 7617 `charset="UTF-8"`). One rule for the renderer,
 * Electron main and the CLI: `btoa` alone would emit Latin-1 bytes for `ü`
 * and throw on anything above U+00FF (`€`).
 */
export function encodeBasicCredentials(credentials: string): string {
  return bytesToBase64(utf8(credentials));
}
