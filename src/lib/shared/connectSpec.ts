/**
 * Connect specs for live connections (SSE, WebSocket, MCP, gRPC reflection).
 *
 * A live connect resolves the same Variable scope a single send does — the
 * active request's globals < environment chain < collection < folders — plus
 * auth inheritance and the Postman send guard, then hands the resolved values
 * to the protocol manager. Builders call one `resolve*Connect` function and
 * either connect with the result or surface its refusal; nothing here renders
 * React or connects.
 *
 * Every value goes through `resolveRequestScopeText` (the HTTP executor's
 * resolver) via the single `resolveField` helper; auth fields resolve before a
 * credential is encoded, so a Basic header can't hide a token. Header names stay
 * as written, as in the CLI. Stored templates are never mutated: the functions
 * return new values.
 *
 * SecretRef-backed variables stay opaque (ADR-0007). None of the live-connect
 * managers can hand a handle to Electron main yet, so a field that still
 * references one after resolution is refused instead of being sent as a
 * literal `{{name}}` placeholder, and SSE refuses a credential only main could
 * apply instead of connecting anonymously.
 */
import { authHeaderNames } from '@shared/protocol/request-spec';
import {
  referencesSecretVariable,
  SecretVariableReferenceError,
} from '@shared/variables/secret-variable-token';
import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { buildAuthCredential } from '@/features/auth/lib/buildAuthCredential';
import { resolveAuthVariables } from '@/features/auth/lib/resolveAuthVariables';
import {
  postmanSendBlockedReason,
  resolveInheritedAuthFor,
} from '@/features/auth/lib/resolveInheritedAuthFor';
import {
  type ReflectionCredentials,
  reflectionCredentialsFor,
} from '@/features/grpc/lib/grpcReflection';
import { buildMcpConnectAuth } from '@/features/mcp/lib/mcpAuth';
import type { McpClientStdioOptions } from '@/features/mcp/lib/mcpClient';
import { buildStdioLaunch } from '@/features/mcp/lib/mcpStdioLaunch';
import { buildActiveRequestVariableResolution } from '@/lib/shared/activeRequestScopes';
import { isElectron } from '@/lib/shared/platform';
import { type RequestScope, resolveRequestScopeText } from '@/lib/shared/resolveRequestScope';
import { keyValuePairsToRecord } from '@/lib/shared/utils';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { GrpcRequest, KeyValue, McpRequest, SseRequest } from '@/types';

/** An explicit refusal: nothing may connect. `error` is user-facing. */
export interface ConnectRefusal {
  ok: false;
  error: string;
}

export type ConnectResult<T> = ({ ok: true } & T) | ConnectRefusal;

/** The resolution scope a connect reads; build once per connect attempt. */
export type ConnectScope = RequestScope;

/** Scope of the ACTIVE request: full Variable scope + the env store's pass. */
export function createConnectScope(): ConnectScope {
  const { values, secretVariables, sendSecretNames } = buildActiveRequestVariableResolution();
  return {
    values,
    secretVariables,
    secretNames: sendSecretNames,
    resolveVariables: useEnvironmentStore.getState().resolveVariables,
  };
}

class ConnectRefused extends Error {}

/** The one resolver call site; every connect field goes through here. */
function resolveField(scope: ConnectScope, text: string, field?: string): string {
  const resolved = resolveRequestScopeText(text, scope, field);
  const secrets = scope.secretVariables;
  if (secrets && referencesSecretVariable(resolved, (name) => Object.hasOwn(secrets, name))) {
    throw new ConnectRefused(
      'A variable used here is stored as a desktop secret, which live connections cannot resolve yet. Use an inline variable value instead.'
    );
  }
  return resolved;
}

/** Run `build`; a refusal or a thrown resolver error becomes a refusal result. */
function guarded<T>(build: () => ConnectResult<T>): ConnectResult<T> {
  try {
    return build();
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ConnectRefused || error instanceof SecretVariableReferenceError
          ? error.message
          : `Could not resolve the connection: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resolveHeaders(scope: ConnectScope, headers: KeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(keyValuePairsToRecord(headers))) {
    out[key] = resolveField(scope, value, `header "${key}"`);
  }
  return out;
}

/**
 * Display-only resolution (host labels, OAuth status lookups). Never refuses:
 * on any failure the template text is returned unchanged.
 */
export function previewConnectText(
  text: string,
  scope: ConnectScope = createConnectScope()
): string {
  try {
    return resolveField(scope, text);
  } catch {
    return text;
  }
}

export interface SseConnectSpec {
  url: string;
  headers: Record<string, string>;
  /** Auth-added header names, removed on a redirect to another origin. */
  stripOnOriginChange: string[];
}

/**
 * Own configured auth wins; otherwise folder/Collection auth is inherited.
 * Sign-at-wire types (sigv4/oauth1/wsse) no-op for SSE (`buildAuthCredential`).
 */
export function resolveSseConnect(
  request: SseRequest,
  scope: ConnectScope = createConnectScope()
): ConnectResult<SseConnectSpec> {
  return guarded<SseConnectSpec>(() => {
    const blocked = postmanSendBlockedReason(request);
    if (blocked) return { ok: false, error: blocked };
    const inherited = resolveInheritedAuthFor(request);
    const effective = inherited ? withEffectiveAuth(request, inherited.auth) : request;

    const resolve = (text: string) => resolveField(scope, text);
    const headers = resolveHeaders(scope, request.headers);
    // Header-based auth (basic/bearer/api-key/oauth2), already resolved.
    const auth = effective.auth && resolveAuthVariables(effective.auth, resolve);
    const credential = buildAuthCredential(auth);
    if (credential.requiresMainSideApply) {
      return {
        ok: false,
        error:
          'This auth uses a keychain-stored or external secret, which SSE connections cannot apply yet. Enter the credential inline, or set auth on this request.',
      };
    }
    Object.assign(headers, credential.headers);

    let url = resolveField(scope, request.url, 'URL');
    // Enabled query params plus any query-placed auth credential.
    const queryParams: Array<[string, string]> = [
      ...request.params
        .filter((p) => p.enabled !== false && p.key)
        .map((p): [string, string] => [resolveField(scope, p.key), resolveField(scope, p.value)]),
      ...Object.entries(credential.params),
    ];
    if (queryParams.length > 0) {
      try {
        const u = new URL(url);
        for (const [k, v] of queryParams) u.searchParams.set(k, v);
        url = u.toString();
      } catch {
        // Not yet an absolute URL: leave it for the manager's validation error.
      }
    }
    return { ok: true, url, headers, stripOnOriginChange: authHeaderNames(auth) };
  });
}

export interface WebSocketConnectSpec {
  url: string;
  /** Resolved handshake headers (empty when none are configured). */
  headers: Record<string, string>;
}

/** WebSocket handshake URL + headers, resolved with the full active scope. */
export function resolveWebSocketConnect(
  connection: { url: string; headers: KeyValue[] },
  scope: ConnectScope = createConnectScope()
): ConnectResult<WebSocketConnectSpec> {
  return guarded<WebSocketConnectSpec>(() => ({
    ok: true,
    url: resolveField(scope, connection.url, 'URL'),
    headers: resolveHeaders(scope, connection.headers),
  }));
}

export interface McpConnectSpec {
  url: string;
  transport: McpRequest['transport'];
  headers: Record<string, string>;
  mainSideAuth?: NonNullable<ReturnType<typeof buildMcpConnectAuth> & { ok: true }>['mainSideAuth'];
  /** Resolved launch config; only for the stdio transport. */
  stdio?: McpClientStdioOptions;
}

/**
 * MCP url, headers, auth (inline on web, main-resolved on desktop) and, for
 * stdio, the launch. Unappliable auth fails closed — an anonymous connect or
 * conformance probe would report misleading 401s.
 */
export function resolveMcpConnect(
  request: McpRequest,
  scope: ConnectScope = createConnectScope(),
  desktop: boolean = isElectron()
): ConnectResult<McpConnectSpec> {
  return guarded<McpConnectSpec>(() => {
    const blocked = postmanSendBlockedReason(request);
    if (blocked) return { ok: false, error: blocked };
    const resolve = (text: string) => resolveField(scope, text);
    const auth = buildMcpConnectAuth({
      auth: request.auth,
      inherited: resolveInheritedAuthFor(request),
      headers: resolveHeaders(scope, request.headers),
      resolve,
      desktop,
    });
    if (!auth.ok) return { ok: false, error: auth.error };
    return {
      ok: true,
      url: resolveField(scope, request.url, 'URL'),
      transport: request.transport,
      headers: auth.headers,
      ...(auth.mainSideAuth ? { mainSideAuth: auth.mainSideAuth } : {}),
      ...(request.transport === 'stdio' ? { stdio: buildStdioLaunch(request.stdio, resolve) } : {}),
    };
  });
}

export interface GrpcReflectionConnectSpec {
  url: string;
  credentials?: ReflectionCredentials;
}

/**
 * Reflection endpoint + the metadata/auth a call would send. `request` is
 * optional (a bare URL probe has no metadata or auth).
 *
 * Auto-discover runs when a tab opens or its URL changes, so `inheritAuth` stays
 * off unless the user asked: an ancestor's credential must not go to a URL
 * nobody chose to call. The request's own auth is not gated by this.
 */
export function resolveGrpcReflectionConnect(
  rawUrl: string,
  request?: GrpcRequest,
  options: { inheritAuth?: boolean } = {},
  scope: ConnectScope = createConnectScope()
): ConnectResult<GrpcReflectionConnectSpec> {
  return guarded<GrpcReflectionConnectSpec>(() => {
    const resolve = (text: string) => resolveField(scope, text);
    const url = resolveField(scope, rawUrl, 'URL');
    if (!request) return { ok: true, url };
    const blocked = postmanSendBlockedReason(request);
    if (blocked) return { ok: false, error: blocked };
    const inherited = options.inheritAuth ? resolveInheritedAuthFor(request) : undefined;
    const effective = inherited ? withEffectiveAuth(request, inherited.auth) : request;
    const resolved = effective.auth
      ? { ...effective, auth: resolveAuthVariables(effective.auth, resolve) }
      : effective;
    return { ok: true, url, credentials: reflectionCredentialsFor(resolved, resolve) };
  });
}
