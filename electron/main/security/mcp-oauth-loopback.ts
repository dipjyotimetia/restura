/**
 * RFC 8252 loopback redirect receiver for the MCP OAuth flow (#856, ADR 0031).
 *
 * A one-shot HTTP listener bound to `127.0.0.1` (never `0.0.0.0`) on an
 * ephemeral port — or a caller-pinned port for a statically registered
 * client whose AS requires an exact redirect URI. It accepts exactly one
 * callback:
 *
 *   - only `GET <path>` with a `Host` header naming this listener (blocks
 *     DNS-rebinding pages and stray local requests);
 *   - the `state` query parameter must equal the expected value (constant-time
 *     compare). A wrong / missing state is answered 400 and IGNORED, so a
 *     local process can't abort a legitimate sign-in by guessing the port;
 *   - the first matching callback settles the wait and the listener closes —
 *     it is single-use;
 *   - the wait is bounded by a timeout and an AbortSignal (disconnect).
 *
 * The authorization code never leaves the main process: the callback params
 * are handed to the OAuth provider for the PKCE token exchange. The AS's
 * `error_description` / `error_uri` are attacker-controlled in a mix-up
 * attack, so only a sanitised `error` code is surfaced.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export const LOOPBACK_CALLBACK_PATH = '/oauth/callback';
export const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;

export class OAuthCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthCallbackError';
  }
}

export interface LoopbackReceiver {
  /** `http://127.0.0.1:<port><path>` — the exact redirect_uri to register / send. */
  readonly redirectUrl: string;
  readonly port: number;
  /** Resolve with the callback params once a request with the matching state arrives. */
  waitForCallback(expectedState: string): Promise<URLSearchParams>;
  close(): void;
}

export interface LoopbackOptions {
  /** 0 (default) = ephemeral. */
  port?: number;
  path?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:3rem;text-align:center"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** RFC 6749 error codes are `[\x20-\x21\x23-\x5B\x5D-\x7E]`; keep a conservative subset. */
function sanitizeErrorCode(code: string): string {
  const cleaned = code.replace(/[^a-z0-9_.-]/gi, '').slice(0, 64);
  return cleaned || 'unknown_error';
}

/** Start the listener. Rejects if the port can't be bound (e.g. a pinned port in use). */
export async function startLoopbackReceiver(
  options: LoopbackOptions = {}
): Promise<LoopbackReceiver> {
  const path = options.path ?? LOOPBACK_CALLBACK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;

  let expected: string | undefined;
  let settled = false;
  let resolveWait: ((params: URLSearchParams) => void) | undefined;
  let rejectWait: ((err: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let port = 0;

  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(400, PAGE_HEADERS).end(page('Bad request', 'Unexpected host.'));
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      res.writeHead(400, PAGE_HEADERS).end(page('Bad request', 'Malformed request.'));
      return;
    }
    if (req.method !== 'GET' || url.pathname !== path) {
      res.writeHead(404, PAGE_HEADERS).end(page('Not found', ''));
      return;
    }
    const state = url.searchParams.get('state');
    if (settled || expected === undefined || state === null || !safeEqual(state, expected)) {
      // Ignore — a stray or forged callback must not end the real flow.
      res
        .writeHead(400, PAGE_HEADERS)
        .end(
          page(
            'Sign-in not recognised',
            'This authorization response does not match a pending Restura sign-in.'
          )
        );
      return;
    }
    settled = true;
    const error = url.searchParams.get('error');
    if (error) {
      res
        .writeHead(200, PAGE_HEADERS)
        .end(page('Sign-in was not completed', 'You can close this window and return to Restura.'));
      finish(new OAuthCallbackError(`Authorization was denied: ${sanitizeErrorCode(error)}`));
      return;
    }
    if (!url.searchParams.get('code')) {
      res.writeHead(400, PAGE_HEADERS).end(page('Sign-in failed', 'No authorization code.'));
      finish(new OAuthCallbackError('Authorization response carried no code'));
      return;
    }
    res
      .writeHead(200, PAGE_HEADERS)
      .end(page('Signed in to the MCP server', 'You can close this window and return to Restura.'));
    finish(undefined, url.searchParams);
  });
  server.keepAliveTimeout = 1;

  const close = (): void => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections?.();
  };

  function finish(err: Error | undefined, params?: URLSearchParams): void {
    settled = true;
    // Let the response flush before the listener goes away.
    setImmediate(close);
    if (err) rejectWait?.(err);
    else if (params) resolveWait?.(params);
  }

  function onAbort(): void {
    if (settled) return;
    settled = true;
    close();
    rejectWait?.(new OAuthCallbackError('Authorization was cancelled'));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  if (options.signal?.aborted) {
    close();
    throw new OAuthCallbackError('Authorization was cancelled');
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });

  return {
    redirectUrl: `http://127.0.0.1:${port}${path}`,
    port,
    waitForCallback(expectedState: string): Promise<URLSearchParams> {
      if (expected !== undefined) {
        return Promise.reject(new OAuthCallbackError('Loopback receiver is single-use'));
      }
      if (settled) return Promise.reject(new OAuthCallbackError('Authorization was cancelled'));
      expected = expectedState;
      return new Promise<URLSearchParams>((resolve, reject) => {
        resolveWait = resolve;
        rejectWait = reject;
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          close();
          reject(
            new OAuthCallbackError(
              `Authorization timed out after ${Math.round(timeoutMs / 1000)}s — sign in again`
            )
          );
        }, timeoutMs);
      });
    },
    close,
  };
}
