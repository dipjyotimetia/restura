/**
 * Pure (electron-free) logic for the capture desktop bridge: request
 * authorization, loopback/CSRF origin checks, and the Zod payload schema. Kept
 * separate from `capture-bridge-handler.ts` so it is trivially unit-testable
 * without an Electron runtime, and so the security checks live in one auditable
 * place.
 */
import { captureSessionSchema } from '@shared/capture/schema';
import { z } from 'zod';

/** Case-insensitive incoming HTTP headers (node lowercases header names). */
export type IncomingHeaders = Record<string, string | string[] | undefined>;

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Constant-time-ish bearer comparison. `token` is the freshly-generated
 * per-session secret; an empty configured token means the bridge is not paired
 * and every request must be rejected.
 */
export function isAuthorized(headers: IncomingHeaders, token: string): boolean {
  if (!token) return false;
  const auth = headerString(headers.authorization);
  if (!auth) return false;
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) return false;
  const provided = auth.slice(prefix.length);
  if (provided.length !== token.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return mismatch === 0;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

/**
 * Reject cross-origin / DNS-rebind attempts. A malicious web page can POST to
 * `http://127.0.0.1:<port>` but the browser will stamp its real `Origin`; only
 * loopback hosts and the extension's own `chrome-extension://` origin are
 * allowed. The `Host` header must also resolve to loopback so a rebound DNS name
 * pointing at 127.0.0.1 is refused.
 */
export function isLoopbackRequest(headers: IncomingHeaders): boolean {
  const host = headerString(headers.host);
  if (!host) return false;
  const hostname = host.includes(':') ? host.slice(0, host.lastIndexOf(':')) : host;
  if (!isLoopbackHostname(hostname)) return false;

  const origin = headerString(headers.origin);
  if (origin === undefined) return true; // no Origin (e.g. same-process tooling) is fine
  if (origin.startsWith('chrome-extension://')) return true;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export const bridgePayloadSchema = z.object({
  session: captureSessionSchema,
  /** Optional collection name override from the extension UI. */
  name: z.string().min(1).max(256).optional(),
});

export type BridgePayload = z.infer<typeof bridgePayloadSchema>;
