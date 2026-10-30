// NTLM handshake for the Electron fetcher (#1069) — desktop-only.
//
// NTLM authenticates the TCP connection, so the NEGOTIATE (type 1) and
// AUTHENTICATE (type 3) legs MUST travel on the socket that received the
// CHALLENGE (type 2). The shared core cannot promise that (its fetchers pool
// or open a connection per call), which is why NTLM lives here, inside one
// Electron fetcher call:
//
//   1. the dispatcher is pinned to a single connection (`createNtlmConnectionPin`)
//      and a second connect attempt fails BEFORE any bytes are written, so the
//      type 3 message can never hop to another pooled socket;
//   2. HTTP/2 is refused — NTLM is connection-scoped and h2 multiplexes;
//   3. leg 1 carries only the type 1 message (flags, no credentials); the type 3
//      proof is computed only after a type 2 challenge arrives on that socket;
//   4. credentials are bound to the origin of the request the user sent — a
//      redirect hop to another origin gets no NTLM header at all.

import { type Agent, buildConnector, Client, type Dispatcher } from 'undici';
import { unwrapSecretValueMain } from '../security/secret-handle-store';
import type { HttpVersionPlan } from './http-version';
import {
  createType1Message,
  createType3Message,
  type NtlmCredentials,
  parseType2Message,
  selectNtlmChallenge,
} from './ntlm-message';

/** NTLM credentials plus the only origin they may be answered for. */
export interface NtlmFetchAuth {
  origin: string;
  credentials: NtlmCredentials;
}

export const NTLM_AFFINITY_ERROR =
  'NTLM handshake failed: the server did not keep the connection open between the ' +
  'challenge and the authenticate message (NTLM authenticates a single connection).';

/** Largest 401 challenge body drained to keep the socket reusable; bigger ones abort. */
const CHALLENGE_BODY_LIMIT = 1024 * 1024;

type AuthLike = {
  type?: string;
  ntlm?: { username: string; password: unknown; domain?: string; workstation?: string };
};

/**
 * Resolve the NTLM credentials (password handle → plaintext, main only per
 * ADR-0007) for a request, bound to the request URL's origin. Returns
 * undefined for any other auth type or an NTLM config without a username.
 */
export function ntlmFetchAuthFor(
  auth: AuthLike | undefined,
  url: string
): NtlmFetchAuth | undefined {
  if (auth?.type !== 'ntlm' || !auth.ntlm?.username) return undefined;
  const { username, domain, workstation } = auth.ntlm;
  const password = unwrapSecretValueMain(auth.ntlm.password);
  // An unresolvable keychain handle must not become an empty-password attempt
  // (it would still count toward the account's lockout threshold).
  if (password === undefined) throw new Error('NTLM password secret could not be resolved');
  return {
    origin: new URL(url).origin,
    credentials: {
      username,
      password,
      ...(domain ? { domain } : {}),
      ...(workstation ? { workstation } : {}),
    },
  };
}

/** NTLM over HTTP needs HTTP/1.1; an explicit HTTP/2 requirement fails loudly. */
export function pinHttp1ForNtlm(plan: HttpVersionPlan, ntlm: unknown): HttpVersionPlan {
  if (!ntlm) return plan;
  if (plan.requireH2) {
    throw new Error(
      'NTLM authentication requires HTTP/1.1 (it authenticates a connection, which HTTP/2 ' +
        'multiplexes). Set the HTTP version to Auto or HTTP/1.1 for this request.'
    );
  }
  return { allowH2: false, preferH2: false, requireH2: false, h2cPriorKnowledge: false };
}

/**
 * Agent/ProxyAgent options that give every origin a single-socket Client and
 * refuse any connection after the first one across the dispatcher's lifetime
 * (one fetcher call). Spread into the dispatcher options: `{ ...pin }`.
 * `proxyTunnel` makes an HTTP proxy CONNECT-tunnel `http:` targets too, so the
 * pinned socket reaches the origin instead of a proxy that may pool upstream
 * connections (Agent and the SOCKS Agent ignore it).
 */
export function createNtlmConnectionPin(): {
  factory: NonNullable<Agent.Options['factory']>;
  proxyTunnel: true;
} {
  let connections = 0;
  return {
    proxyTunnel: true,
    factory: (origin: string | URL, opts: object) => {
      const options = opts as Client.Options & { connect?: unknown };
      const inner: buildConnector.connector =
        typeof options.connect === 'function'
          ? (options.connect as buildConnector.connector)
          : buildConnector({
              ...((options.connect as buildConnector.BuildOptions | undefined) ?? {}),
              allowH2: false,
            });
      const connect: buildConnector.connector = (connectOpts, cb) => {
        connections += 1;
        if (connections > 1) {
          cb(new Error(NTLM_AFFINITY_ERROR), null);
          return;
        }
        inner(connectOpts, cb);
      };
      return new Client(origin, { ...options, connect, allowH2: false, pipelining: 1 });
    },
  };
}

function withAuthorization(headers: Record<string, string>, value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'authorization') out[k] = v;
  }
  out['Authorization'] = value;
  return out;
}

function headerList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Run the NTLM handshake through `send` (one pinned dispatcher). Returns the
 * type 1 leg's response untouched when the server does not answer with a
 * type 2 challenge (no auth needed, or another scheme), else the type 3 leg's.
 */
export async function dispatchWithNtlm(
  send: (headers: Record<string, string>) => Promise<Dispatcher.ResponseData>,
  headers: Record<string, string>,
  credentials: NtlmCredentials
): Promise<Dispatcher.ResponseData> {
  const negotiate = await send(withAuthorization(headers, `NTLM ${createType1Message()}`));
  if (negotiate.statusCode !== 401) return negotiate;
  const token = selectNtlmChallenge(headerList(negotiate.headers['www-authenticate']));
  if (!token) return negotiate;

  let authenticate: string;
  try {
    const keepAlive = !headerList(negotiate.headers.connection).some((v) =>
      v
        .toLowerCase()
        .split(',')
        .some((t) => t.trim() === 'close')
    );
    if (!keepAlive) throw new Error(NTLM_AFFINITY_ERROR);
    authenticate = createType3Message(parseType2Message(token), credentials);
  } catch (err) {
    negotiate.body.once('error', () => {}).destroy();
    throw err;
  }
  // Drain (not destroy) so the socket returns to the Client for the type 3 leg.
  // Past the limit `dump` destroys the body (and with it the socket) instead.
  await negotiate.body.dump({ limit: CHALLENGE_BODY_LIMIT });
  if (!negotiate.body.readableEnded) {
    throw new Error('NTLM handshake failed: the challenge response body exceeds 1 MiB');
  }
  return send(withAuthorization(headers, `NTLM ${authenticate}`));
}
