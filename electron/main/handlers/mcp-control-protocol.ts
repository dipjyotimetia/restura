/**
 * Pure (electron-free) security + handshake logic for the MCP control server
 * (ADR 0041). Kept apart from the listener so every check is unit-testable
 * and lives in one auditable place.
 *
 * Threat model for the loopback listener:
 *  - Any local process can connect to 127.0.0.1 — so every request needs the
 *    256-bit bearer token, compared in constant time.
 *  - A web page in the user's browser can also reach 127.0.0.1 (CSRF / DNS
 *    rebinding). MCP clients are not browsers, so a request carrying an
 *    `Origin` (or any `Sec-Fetch-*` metadata) is refused outright, and the
 *    `Host` header must name a loopback host so a rebound DNS name fails.
 *  - The token sits in a 0600 handshake file under userData; the stdio shim
 *    reads it from there, so it never has to be written into agent configs.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  HANDSHAKE_FILE_NAME,
  type HandshakeFile,
  HandshakeFileSchema,
  sanitizeLabel,
} from '@shared/mcp-server/control-bridge';
import { type IncomingHeaders, isAuthorized } from './capture-bridge-protocol';

export type { IncomingHeaders };
export { isAuthorized };

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export type ControlRequestRejection = 'host' | 'browser-origin';

/**
 * Transport-level gate, before authentication. Returns the rejection reason,
 * or `null` when the request may proceed to the bearer check.
 */
export function rejectControlRequest(headers: IncomingHeaders): ControlRequestRejection | null {
  const host = headerString(headers.host);
  if (!host) return 'host';
  // Strip the port. IPv6 literals keep their brackets: `[::1]:4000` → `[::1]`.
  const hostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.includes(':')
      ? host.slice(0, host.lastIndexOf(':'))
      : host;
  if (!isLoopbackHostname(hostname.toLowerCase())) return 'host';
  // Browsers stamp Origin on cross-origin POSTs, and Sec-Fetch-Site /
  // Sec-Fetch-Dest on every request. MCP clients send none of these — note
  // Node's built-in fetch (Claude Code, Codex, the shim) DOES send
  // `Sec-Fetch-Mode: cors`, so that header alone must not be refused.
  if (headerString(headers.origin) !== undefined) return 'browser-origin';
  if (headerString(headers['sec-fetch-site']) !== undefined) return 'browser-origin';
  if (headerString(headers['sec-fetch-dest']) !== undefined) return 'browser-origin';
  return null;
}

/** Display-only client label: the shim's forwarded name, else the User-Agent. */
export function clientLabelFromHeaders(headers: IncomingHeaders): string | undefined {
  const raw = headerString(headers['x-restura-mcp-client']) ?? headerString(headers['user-agent']);
  if (!raw) return undefined;
  // Printable ASCII only, bounded: this ends up in the UI.
  const cleaned = sanitizeLabel(raw);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function handshakePath(userDataDir: string): string {
  return path.join(userDataDir, HANDSHAKE_FILE_NAME);
}

/** Read and validate the handshake file. Missing / corrupt → `null`. */
export async function readHandshake(userDataDir: string): Promise<HandshakeFile | null> {
  try {
    const raw = await fs.readFile(handshakePath(userDataDir), 'utf8');
    const parsed = HandshakeFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Write the handshake atomically with owner-only permissions: write a temp
 * file with mode 0600, then rename over the target, so a reader never sees a
 * torn file and the token is never world-readable even briefly.
 */
export async function writeHandshake(userDataDir: string, data: HandshakeFile): Promise<void> {
  const target = handshakePath(userDataDir);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  // rename keeps the temp file's mode, but tighten again in case the target
  // pre-existed with looser permissions on a platform that preserves them.
  await fs.chmod(target, 0o600).catch(() => undefined);
}

/**
 * True when `pid` names a live process *this user may signal* (signal 0
 * probes without signalling). EPERM — a process owned by another user — is
 * not the Restura that wrote the handshake (a reused pid), so it counts as
 * not alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
