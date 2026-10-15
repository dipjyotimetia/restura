/**
 * Main-side WebSocket handshake credential materialization (#878, #882).
 *
 * GraphQL subscriptions tunnel `graphql-ws` over the WebSocket IPC bridge.
 * When their auth is backed by a SecretRef handle / external secret, or the
 * URL/headers/auth reference SecretRef-backed `{{vars}}`, the renderer sends
 * only the opaque refs (ADR-0007). This resolves them here, at wire time:
 *
 *   1. secret-variable tokens in the URL, header values and auth fields,
 *   2. external-vault auth refs,
 *   3. header-shaped auth → headers (+ `in: query` API keys onto the URL).
 *
 * The resulting plaintext only ever lives in the main process; it is never
 * echoed back to the renderer (errors name the variable, not its value).
 */

import type { ProtocolAuthConfig, ProtocolSecretValue } from '@shared/protocol/types';
import { isDeniedWsHeader } from '../ipc/validators/core';
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

/** Substitute secret-variable tokens into the plain-string credential fields. */
function replaceInAuth(auth: HeaderAuth, values: Record<string, string>): HeaderAuth {
  const sub = <T>(v: T): T =>
    typeof v === 'string' ? (replaceSecretVariableTokens(v, values) as T) : v;
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
    ...(auth.apiKey
      ? { apiKey: { ...auth.apiKey, key: sub(auth.apiKey.key), value: sub(auth.apiKey.value) } }
      : {}),
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

/**
 * Resolve handshake credentials main-side. Returns the config untouched when
 * there is nothing opaque to resolve. Throws (caller maps to a connect error)
 * when a secret is unavailable, the final URL isn't ws(s), or applied auth
 * would set a forbidden handshake header.
 */
export async function materializeWsHandshakeAuth(
  config: WsHandshakeAuthConfig,
  signal?: AbortSignal
): Promise<{ url: string; headers: Record<string, string> }> {
  const hasSecrets = !!config.secretVariables && Object.keys(config.secretVariables).length > 0;
  if (!config.auth && !hasSecrets) {
    return { url: config.url, headers: config.headers ?? {} };
  }

  const values = hasSecrets
    ? await resolveSecretVariableValues(config.secretVariables ?? {}, signal)
    : {};
  const sub = (text: string) => replaceSecretVariableTokens(text, values);

  let url = sub(config.url);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers ?? {})) headers[key] = sub(value);

  if (config.auth) {
    const withVars = replaceInAuth(config.auth as HeaderAuth, values);
    const auth = await materializeExternalProtocolAuth(withVars, signal);
    const applied = applyNonSignAtWireAuth(auth as HeaderAuth | undefined);
    for (const [key, value] of Object.entries(applied.headers)) {
      if (isDeniedWsHeader(key)) {
        throw new Error(`Auth header "${key}" is not allowed on a WebSocket handshake`);
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

  // A secret variable may have supplied part of the URL — re-check the scheme
  // (SSRF/host validation runs on this final URL in the caller).
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error('Invalid WebSocket URL after resolving secrets');
  }
  if (protocol !== 'ws:' && protocol !== 'wss:') {
    throw new Error('Only ws: and wss: WebSocket URLs are allowed');
  }

  return { url, headers };
}
