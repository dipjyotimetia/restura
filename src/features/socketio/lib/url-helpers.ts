import { SOCKETIO_VALID_SCHEMES } from '@shared/socketio-constants';

/**
 * Join a Socket.IO base URL with a namespace path. Socket.IO's `io()` accepts
 * either `(url, { path })` or a namespace-suffixed URL — we use the latter so
 * the wire URL exactly mirrors user intent.
 *
 * Returns the input unchanged for the default namespace (`/`), an empty
 * namespace, or an unparseable URL.
 */
export function buildSocketIOConnectUrl(rawUrl: string, namespace: string | undefined): string {
  if (!namespace || namespace === '/' || namespace === '') return rawUrl;
  try {
    const u = new URL(rawUrl);
    const origin = `${u.protocol}//${u.host}`;
    const ns = namespace.startsWith('/') ? namespace : `/${namespace}`;
    return `${origin}${ns}`;
  } catch {
    return rawUrl;
  }
}

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
}

/** Renderer-side URL validation. The Electron handler's Zod schema enforces the same rules at the IPC boundary. */
export function validateSocketIOUrl(url: string): UrlValidationResult {
  if (!url || !url.trim()) return { valid: false, error: 'URL is required' };
  try {
    const parsed = new URL(url);
    if (!SOCKETIO_VALID_SCHEMES.has(parsed.protocol)) {
      return { valid: false, error: `Invalid protocol "${parsed.protocol}". Use http(s):// or ws(s)://` };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}
