import { SOCKETIO_VALID_SCHEMES } from '@shared/socketio-constants';
import { socketIoConnectUrl } from '@shared/socketio-url';

/**
 * The URL `io()` connects to: the WHATWG serialisation joined with the
 * namespace (see `socketIoConnectUrl`). Returns an unparseable URL unchanged so
 * the connect guard reports it.
 */
export function buildSocketIOConnectUrl(rawUrl: string, namespace: string | undefined): string {
  try {
    return socketIoConnectUrl(rawUrl, namespace);
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
  if (!url?.trim()) return { valid: false, error: 'URL is required' };
  try {
    const parsed = new URL(url);
    if (!SOCKETIO_VALID_SCHEMES.has(parsed.protocol)) {
      return {
        valid: false,
        error: `Invalid protocol "${parsed.protocol}". Use http(s):// or ws(s)://`,
      };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}
