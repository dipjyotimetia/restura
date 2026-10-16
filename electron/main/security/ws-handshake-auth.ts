/**
 * Main-side WebSocket handshake credential materialization (#878, #882).
 *
 * GraphQL subscriptions tunnel `graphql-ws` over the WebSocket IPC bridge and
 * graphql-sse over the SSE IPC bridge. When their auth is backed by a SecretRef handle / external secret, or the
 * URL/headers/auth reference SecretRef-backed `{{vars}}`, the renderer sends
 * only the opaque refs (ADR-0007). This resolves them here, at wire time:
 *
 *   1. secret-variable tokens in the URL, header values and auth value fields,
 *   2. external-vault auth refs,
 *   3. header-shaped auth → headers (+ `in: query` API keys onto the URL).
 *
 * The resulting plaintext only ever lives in the main process. Thrown errors
 * name the variable / header, never a value, and the returned `redact` scrubs
 * every resolved plaintext from anything the caller sends back to the renderer.
 */

import type { ProtocolAuthConfig, ProtocolSecretValue } from '@shared/protocol/types';
import { isDeniedStreamingHeader, isDeniedWsHeader } from '../ipc/validators/core';
import { applyNonSignAtWireAuth } from './auth-applier';
import { materializeExternalProtocolAuth } from './external-secret-materializer';
import {
  replaceSecretVariableTokens,
  resolveSecretVariableValues,
} from './secret-variable-materializer';

export interface WsHandshakeAuthConfig {
  url: string;
  headers?: Record<string, string> | undefined;
  auth?: ProtocolAuthConfig | undefined;
  secretVariables?: Record<string, ProtocolSecretValue> | undefined;
}

type HeaderAuth = ProtocolAuthConfig & {
  basic?: { username: string; password: unknown };
  bearer?: { token: unknown };
  apiKey?: { key: string; value: unknown; in: 'header' | 'query' };
  oauth2?: { accessToken: unknown; tokenType?: string };
};

/**
 * Substitute secret-variable tokens into the credential VALUE fields. The API
 * key's `key` is a header / query-param NAME and is deliberately left alone —
 * a secret-derived name could otherwise surface in header errors.
 */
function replaceInAuth(auth: HeaderAuth, values: Record<string, string>): HeaderAuth {
  // Plain strings and inline SecretRefs (`{ kind: 'inline', value }`, which the
  // renderer sends verbatim) carry `{{tokens}}`; handle / external refs don't.
  const sub = <T>(v: T): T => {
    if (typeof v === 'string') return replaceSecretVariableTokens(v, values) as T;
    if (
      v &&
      typeof v === 'object' &&
      (v as { kind?: unknown }).kind === 'inline' &&
      typeof (v as { value?: unknown }).value === 'string'
    ) {
      const inline = v as unknown as { kind: 'inline'; value: string };
      return { ...inline, value: replaceSecretVariableTokens(inline.value, values) } as T;
    }
    return v;
  };
  return {
    ...auth,
    ...(auth.bearer ? { bearer: { ...auth.bearer, token: sub(auth.bearer.token) } } : {}),
    ...(auth.basic
      ? {
          basic: {
            ...auth.basic,
            username: sub(auth.basic.username),
            password: sub(auth.basic.password),
          },
        }
      : {}),
    ...(auth.apiKey ? { apiKey: { ...auth.apiKey, value: sub(auth.apiKey.value) } } : {}),
    ...(auth.oauth2
      ? {
          oauth2: {
            ...auth.oauth2,
            accessToken: sub(auth.oauth2.accessToken),
            ...(auth.oauth2.tokenType !== undefined
              ? { tokenType: sub(auth.oauth2.tokenType) }
              : {}),
          },
        }
      : {}),
  };
}

/** Per-transport rules for where resolved credentials may go. */
export interface StreamingAuthTransport {
  /** URL schemes the final (secret-resolved) URL must use. */
  allowedSchemes: readonly string[];
  /** Header names applied auth must never set. */
  isForbiddenHeader: (name: string) => boolean;
  /** Noun used in error messages ("WebSocket", "SSE"). */
  label: string;
}

/** WebSocket upgrade: the IPC denylist plus every `Sec-WebSocket-*` header. */
export const WS_HANDSHAKE_TRANSPORT: StreamingAuthTransport = {
  allowedSchemes: ['ws:', 'wss:'],
  isForbiddenHeader: (name) => isDeniedWsHeader(name) || /^sec-websocket-/i.test(name),
  label: 'WebSocket',
};

/** graphql-sse POST: the SSE IPC denylist plus body-framing headers. */
export const SSE_REQUEST_TRANSPORT: StreamingAuthTransport = {
  allowedSchemes: ['http:', 'https:'],
  isForbiddenHeader: (name) =>
    isDeniedStreamingHeader(name) || /^(content-length|content-type)$/i.test(name),
  label: 'SSE',
};

// CR / LF / NUL in a header value would split or truncate the upgrade request.
const INVALID_HEADER_VALUE = /[\r\n\0]/;

export type SecretRedactor = (text: string) => string;

const identity: SecretRedactor = (text) => text;

/**
 * Build a redactor that scrubs every resolved plaintext (raw, URI-encoded and
 * form-encoded) from text bound for the renderer or logs. Longest first so a
 * secret containing another is scrubbed whole.
 */
export function createSecretRedactor(secrets: Iterable<string>): SecretRedactor {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
    variants.add(new URLSearchParams({ v: secret }).toString().slice(2));
  }
  const ordered = [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return identity;
  return (text) => {
    let out = text;
    for (const v of ordered) out = out.split(v).join('[redacted]');
    return out;
  };
}

export interface MaterializedWsHandshake {
  url: string;
  headers: Record<string, string>;
  /** Scrubs resolved plaintext from replies / events / logs for this connection. */
  redact: SecretRedactor;
}

/** True when the connect carries opaque credentials that need main-side resolution. */
export function needsWsHandshakeMaterialization(config: WsHandshakeAuthConfig): boolean {
  return (
    config.auth !== undefined ||
    (!!config.secretVariables && Object.keys(config.secretVariables).length > 0)
  );
}

/**
 * Resolve handshake credentials main-side. Returns the config untouched when
 * there is nothing opaque to resolve. Throws (caller maps to a connect error)
 * when a secret or credential is unavailable — fail closed, never an
 * unauthenticated socket — the final URL isn't ws(s), a header value is
 * malformed, or applied auth would set a forbidden handshake header. Thrown
 * messages never contain resolved plaintext.
 */
export async function materializeWsHandshakeAuth(
  config: WsHandshakeAuthConfig,
  signal?: AbortSignal
): Promise<MaterializedWsHandshake> {
  return materializeStreamingAuth(config, WS_HANDSHAKE_TRANSPORT, signal);
}

/**
 * Transport-parameterised core shared by the WebSocket and SSE IPC handlers
 * (GraphQL subscriptions over graphql-ws / graphql-sse, #878/#882).
 */
export async function materializeStreamingAuth(
  config: WsHandshakeAuthConfig,
  transport: StreamingAuthTransport,
  signal?: AbortSignal
): Promise<MaterializedWsHandshake> {
  if (!needsWsHandshakeMaterialization(config)) {
    return { url: config.url, headers: config.headers ?? {}, redact: identity };
  }

  const values: Record<string, string> =
    config.secretVariables && Object.keys(config.secretVariables).length > 0
      ? await resolveSecretVariableValues(config.secretVariables, signal)
      : Object.create(null);
  signal?.throwIfAborted();
  const secrets = new Set<string>(Object.values(values));
  const sub = (text: string) => replaceSecretVariableTokens(text, values);

  let url = sub(config.url);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers ?? {})) headers[key] = sub(value);

  if (config.auth) {
    const withVars = replaceInAuth(config.auth as HeaderAuth, values);
    const auth = (await materializeExternalProtocolAuth(withVars, signal)) as
      | HeaderAuth
      | undefined;
    signal?.throwIfAborted();
    const applied = applyNonSignAtWireAuth(auth);
    const appliedValues = [...Object.values(applied.headers), ...Object.values(applied.params)];
    // A configured credential that resolves to nothing (revoked / missing
    // handle, empty vault value) must not silently open an unauthenticated socket.
    if (config.auth.type !== 'none' && appliedValues.length === 0) {
      throw new Error('Auth credential is unavailable on this device');
    }
    for (const value of appliedValues) {
      secrets.add(value);
      // `Bearer <tok>` / `Basic <b64>`: the credential part alone too.
      const space = value.indexOf(' ');
      if (space > 0 && space < value.length - 1) secrets.add(value.slice(space + 1));
    }
    // Basic's secret is otherwise only visible base64-encoded in the header.
    const basicPassword = auth?.basic?.password as string | { kind?: string; value?: unknown };
    if (typeof basicPassword === 'string') secrets.add(basicPassword);
    else if (basicPassword?.kind === 'inline' && typeof basicPassword.value === 'string') {
      secrets.add(basicPassword.value);
    }

    for (const [key, value] of Object.entries(applied.headers)) {
      if (transport.isForbiddenHeader(key)) {
        throw new Error(
          transport === WS_HANDSHAKE_TRANSPORT
            ? `Auth header "${key}" is not allowed on a WebSocket handshake`
            : `Auth header "${key}" is not allowed on an ${transport.label} request`
        );
      }
      // Auth wins over a user header of the same name in any casing — never
      // send two Authorization headers.
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
      }
      headers[key] = value;
    }
    const params = Object.entries(applied.params);
    if (params.length > 0) {
      const parsed = new URL(url);
      for (const [key, value] of params) parsed.searchParams.append(key, value);
      url = parsed.toString();
    }
  }

  for (const [key, value] of Object.entries(headers)) {
    if (INVALID_HEADER_VALUE.test(value)) {
      throw new Error(`Header "${key}" contains invalid characters`);
    }
  }

  // A secret variable may have supplied part of the URL — re-check the scheme
  // (SSRF/host validation runs on this final URL in the caller).
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`Invalid ${transport.label} URL after resolving secrets`);
  }
  if (!transport.allowedSchemes.includes(protocol)) {
    throw new Error(
      transport === WS_HANDSHAKE_TRANSPORT
        ? 'Only ws: and wss: WebSocket URLs are allowed'
        : `Only ${transport.allowedSchemes.join(' and ')} ${transport.label} URLs are allowed`
    );
  }

  return { url, headers, redact: createSecretRedactor(secrets) };
}
