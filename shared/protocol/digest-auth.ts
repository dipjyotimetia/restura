// HTTP Digest access authentication (RFC 7616, with RFC 2617/2069 fallbacks).
//
// Digest is challenge/response: the first request goes out WITHOUT
// credentials, the upstream answers `401` + `WWW-Authenticate: Digest …`, and
// one retry carries an `Authorization: Digest …` header whose `response` is a
// hash over the credentials, the server nonce, and the request method + target.
// The password itself never goes on the wire.
//
// This module is pure (Web Crypto + a small MD5, no Node APIs) so the Worker,
// the Node self-host server, Electron main and the CLI all run the same code.
// The retry orchestration lives in `http-proxy.ts`; secrets are resolved by the
// caller-supplied `SecretResolver` at wire time (desktop handles resolve in
// main per ADR-0007 — never in the renderer).

import { bytesToHex, md5Hex, sha256Hex } from './crypto-utils';
import { headerFieldValues } from './header-policy';
import { HTTP_METHOD_TOKEN_RE } from './http-method';
import { type FollowRedirectsOptions, followRedirects } from './redirect-follower';
import type { Fetcher, FetcherRequest, FetcherResponse } from './types';

export type DigestAlgorithm = 'MD5' | 'MD5-sess' | 'SHA-256' | 'SHA-256-sess';

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  /** Absent means the RFC 2069 default, MD5. */
  algorithm?: DigestAlgorithm;
  /** Offered qop values, lower-cased. Absent means RFC 2069 (no qop). */
  qop?: string[];
}

export interface DigestCredentials {
  username: string;
  password: string;
}

export interface DigestRequestTarget {
  method: string;
  /** The request-target exactly as sent on the wire (path + query). */
  uri: string;
}

export interface DigestBuildOptions {
  /** Fixed client nonce — tests only; defaults to 128 random bits as hex. */
  cnonce?: string;
}

// ---------------------------------------------------------------------------
// WWW-Authenticate parsing
// ---------------------------------------------------------------------------

interface RawChallenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Parse one or more `WWW-Authenticate` field values into challenges. Handles
 * several challenges folded into one field (`Basic realm="a", Digest …`),
 * quoted-strings with escaped quotes/commas, and token68 credentials of other
 * schemes (which are skipped harmlessly — only Digest params are consumed).
 */
function parseChallenges(values: readonly string[]): RawChallenge[] {
  const out: RawChallenge[] = [];
  for (const header of values) {
    let i = 0;
    let current: RawChallenge | null = null;
    const n = header.length;
    const skipWs = () => {
      while (i < n && (header[i] === ' ' || header[i] === '\t')) i++;
    };
    const readToken = () => {
      const start = i;
      while (i < n && HTTP_METHOD_TOKEN_RE.test(header[i]!)) i++;
      return header.slice(start, i);
    };
    while (i < n) {
      while (i < n && /[\s,]/.test(header[i]!)) i++;
      if (i >= n) break;
      const token = readToken();
      if (!token) {
        i++; // stray character — skip it
        continue;
      }
      skipWs();
      if (header[i] === '=') {
        i++;
        skipWs();
        let value = '';
        if (header[i] === '"') {
          i++;
          while (i < n && header[i] !== '"') {
            if (header[i] === '\\' && i + 1 < n) i++;
            value += header[i];
            i++;
          }
          i++; // closing quote
        } else {
          const start = i;
          while (i < n && header[i] !== ',' && !/\s/.test(header[i]!)) i++;
          value = header.slice(start, i);
        }
        if (current) current.params[token.toLowerCase()] = value;
      } else {
        current = { scheme: token, params: {} };
        out.push(current);
      }
    }
  }
  return out;
}

const ALGORITHM_RANK: Record<DigestAlgorithm, number> = {
  'SHA-256': 4,
  'SHA-256-sess': 3,
  MD5: 2,
  'MD5-sess': 1,
};

function normaliseAlgorithm(raw: string | undefined): DigestAlgorithm | null {
  if (raw === undefined) return 'MD5';
  const upper = raw.toUpperCase();
  for (const alg of Object.keys(ALGORITHM_RANK) as DigestAlgorithm[]) {
    if (alg.toUpperCase() === upper) return alg;
  }
  return null;
}

/**
 * Pick the strongest supported Digest challenge from the `WWW-Authenticate`
 * values of a 401. Returns null when none is usable — no Digest challenge at
 * all, an unsupported algorithm (e.g. SHA-512-256), a missing nonce, or a
 * challenge that only offers `qop=auth-int`.
 */
export function selectDigestChallenge(values: readonly string[]): DigestChallenge | null {
  let best: { challenge: DigestChallenge; rank: number } | null = null;
  for (const c of parseChallenges(values)) {
    if (c.scheme.toLowerCase() !== 'digest') continue;
    const { realm, nonce, opaque, qop } = c.params;
    if (!nonce) continue;
    const algorithm = normaliseAlgorithm(c.params.algorithm);
    if (!algorithm) continue;
    let qopList: string[] | undefined;
    if (qop !== undefined) {
      qopList = qop
        .split(',')
        .map((q) => q.trim().toLowerCase())
        .filter(Boolean);
      if (!qopList.includes('auth')) continue;
    }
    const challenge: DigestChallenge = {
      realm: realm ?? '',
      nonce,
      ...(opaque !== undefined ? { opaque } : {}),
      ...(c.params.algorithm !== undefined ? { algorithm } : {}),
      ...(qopList ? { qop: qopList } : {}),
    };
    const rank = ALGORITHM_RANK[algorithm];
    if (!best || rank > best.rank) best = { challenge, rank };
  }
  return best?.challenge ?? null;
}

// ---------------------------------------------------------------------------
// Response computation
// ---------------------------------------------------------------------------

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Build the `Authorization: Digest …` value answering `challenge` for the
 * given request. Uses qop=auth with nc=00000001 when the server offered qop,
 * else the RFC 2069 form. Only the hash `response` is emitted — never the
 * password.
 */
export async function buildDigestAuthorization(
  challenge: DigestChallenge,
  creds: DigestCredentials,
  target: DigestRequestTarget,
  options: DigestBuildOptions = {}
): Promise<string> {
  const algorithm = challenge.algorithm ?? 'MD5';
  const H = algorithm.startsWith('SHA-256') ? sha256Hex : async (s: string) => md5Hex(s);
  const cnonce = options.cnonce ?? randomHex(16);
  const nc = '00000001';
  const useQop = challenge.qop !== undefined;

  let ha1 = await H(`${creds.username}:${challenge.realm}:${creds.password}`);
  if (algorithm.endsWith('-sess')) {
    ha1 = await H(`${ha1}:${challenge.nonce}:${cnonce}`);
  }
  const ha2 = await H(`${target.method}:${target.uri}`);
  const response = useQop
    ? await H(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`)
    : await H(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username=${quote(creds.username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(target.uri)}`,
    ...(challenge.algorithm ? [`algorithm=${algorithm}`] : []),
    `response=${quote(response)}`,
    ...(challenge.opaque !== undefined ? [`opaque=${quote(challenge.opaque)}`] : []),
    ...(useQop ? ['qop=auth', `nc=${nc}`, `cnonce=${quote(cnonce)}`] : []),
  ];
  return `Digest ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Challenge/retry orchestration (used by executeHttpProxy{,Streaming})
// ---------------------------------------------------------------------------

/**
 * The request-target as it goes on the wire: everything after the authority,
 * minus the fragment. String-based (not `new URL`) so an `encodeUrl: false`
 * URL keeps its raw bytes — the digest `uri` must match what the server sees.
 */
export function requestTargetOf(url: string): string {
  const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/#[\s\S]*$/, '');
  if (rest === '') return '/';
  return rest.startsWith('?') ? `/${rest}` : rest;
}

async function discardBody(response: FetcherResponse): Promise<void> {
  try {
    if (response.body) await response.body.cancel();
  } catch {
    // Best effort — the stream may already be closed.
  }
}

export interface DigestRetryOptions {
  credentials: DigestCredentials;
  /** Produces a fresh copy of the request body for the replay (FormData / bytes are rebuilt, not reused). */
  rebuildBody: () => BodyInit | undefined;
}

/**
 * Send `initialReq` (following redirects as usual) and, when `digest` is set
 * and the final response is a `401` carrying a usable Digest challenge from a
 * chain that never left the initial origin (EVERY hop same-origin, not just
 * the first and last), replay that final hop exactly once with an
 * `Authorization: Digest …` header. The first request never carries Digest
 * credentials. A non-Digest 401, or a 401 reached through a chain that touched
 * another origin, is returned untouched. The retry continues the same redirect
 * budget rather than getting a fresh `maxRedirects`.
 */
export async function followRedirectsWithDigest(
  initialReq: FetcherRequest,
  fetcher: Fetcher,
  redirectOptions: FollowRedirectsOptions,
  digest: DigestRetryOptions | undefined
): Promise<FetcherResponse> {
  if (!digest) return followRedirects(initialReq, fetcher, redirectOptions);

  const origin = new URL(initialReq.url).origin;
  let last = initialReq;
  let calls = 0;
  let leftOrigin = false;
  const tracking: Fetcher = (req) => {
    last = req;
    calls++;
    if (new URL(req.url).origin !== origin) leftOrigin = true;
    return fetcher(req);
  };
  const first = await followRedirects(initialReq, tracking, redirectOptions);
  if (first.status !== 401 || leftOrigin) return first;
  const challenge = selectDigestChallenge(headerFieldValues(first.headers, 'www-authenticate'));
  if (!challenge) return first;

  // Method exactly as sent on the wire (custom methods are case-preserved).
  const authorization = await buildDigestAuthorization(challenge, digest.credentials, {
    method: last.method,
    uri: requestTargetOf(last.url),
  });
  await discardBody(first);
  const headers = new Headers(last.headers);
  headers.set('Authorization', authorization);
  return followRedirects(
    { ...last, headers, body: last.body === undefined ? undefined : digest.rebuildBody() },
    fetcher,
    { ...redirectOptions, hopsUsed: (redirectOptions.hopsUsed ?? 0) + calls - 1 }
  );
}
