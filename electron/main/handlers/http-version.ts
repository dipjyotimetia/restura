import type { HttpVersionPreference } from '@shared/types';

/**
 * How the desktop undici dispatcher should negotiate the HTTP version for one
 * request (#864). Derived from the per-request `httpVersion` preference and
 * the URL scheme; consumed by every dispatcher path in http-handler.ts.
 */
export interface HttpVersionPlan {
  /** Offer `h2` in ALPN (TLS) / let undici run an h2 session. */
  allowH2: boolean;
  /** Put `h2` first in the ALPN list (undici defaults to http/1.1 first). */
  preferH2: boolean;
  /** Fail the request unless the connection actually negotiated h2. */
  requireH2: boolean;
  /** Cleartext HTTP/2 with prior knowledge (RFC 9113 §3.3) — undici `useH2c`. */
  h2cPriorKnowledge: boolean;
}

export function resolveHttpVersionPlan(
  preference: HttpVersionPreference | undefined,
  isHttps: boolean
): HttpVersionPlan {
  switch (preference) {
    case 'http1.1':
      return { allowH2: false, preferH2: false, requireH2: false, h2cPriorKnowledge: false };
    case 'http2':
    case 'h2c-prior-knowledge':
      // TLS: require ALPN h2. Cleartext: undici has no `Upgrade: h2c` support,
      // so HTTP/2 over http: is only reachable via prior knowledge.
      return isHttps
        ? { allowH2: true, preferH2: true, requireH2: true, h2cPriorKnowledge: false }
        : { allowH2: true, preferH2: true, requireH2: true, h2cPriorKnowledge: true };
    default:
      // 'auto' (and omitted): the pre-#864 behaviour — h2 offered over TLS only.
      return { allowH2: isHttps, preferH2: false, requireH2: false, h2cPriorKnowledge: false };
  }
}

/** Error raised when `http2` was required but the server negotiated something else. */
export function h2NotNegotiatedError(alpn: string | undefined): Error {
  return new Error(
    `Server did not negotiate HTTP/2 (ALPN: ${alpn || 'none'}). ` +
      'Set the HTTP version to Auto or HTTP/1.1 for this server.'
  );
}
