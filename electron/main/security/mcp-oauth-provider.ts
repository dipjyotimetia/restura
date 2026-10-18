/**
 * MCP OAuth 2.1 client for Electron main (#856, ADR 0031).
 *
 * Implements the MCP SDK's `OAuthClientProvider` and drives the SDK `auth()`
 * orchestrator itself, handing the MCP transport only a minimal
 * `AuthProvider` ({ token, onUnauthorized }). Driving `auth()` here — instead
 * of passing the OAuth provider straight to the transport — lets every OAuth
 * request use the dedicated SSRF-guarded, size-capped fetch
 * (`mcp-oauth-fetch.ts`) while the MCP transport keeps its DNS-pinned fetch.
 *
 * What the SDK does for us (spec-compliant, not re-implemented):
 *   - RFC 9728 Protected Resource Metadata discovery (from the 401's
 *     `WWW-Authenticate: resource_metadata=` or the well-known URL) and the
 *     resource ↔ server match check;
 *   - RFC 8414 / OIDC AS metadata discovery with the issuer-echo check
 *     (`skipIssuerMetadataValidation` is never set);
 *   - RFC 7591 Dynamic Client Registration;
 *   - PKCE S256, RFC 8707 `resource` on authorize + token requests, RFC 9207
 *     `iss` validation on the callback, refresh_token grant, https-only token
 *     endpoint (loopback exempt).
 *
 * What Restura adds:
 *   - system-browser authorization (`shell.openExternal`, after URL validation)
 *     with an RFC 8252 loopback redirect (`mcp-oauth-loopback.ts`, exact
 *     state check, single use, timeout);
 *   - storage of tokens + DCR registrations ONLY in the encrypted secret handle
 *     store under an internal scope (`mcp-oauth-store.ts`); the PKCE verifier,
 *     state and discovery state live in memory for one flow;
 *   - proactive refresh before expiry; when a refresh fails mid-session, NO
 *     browser pops up — {@link McpOAuthReauthRequiredError} is raised and the
 *     renderer shows a "sign in again" prompt (reconnect = interactive);
 *   - a live redactor over every token / secret / code this session has seen.
 */

import * as crypto from 'node:crypto';
import {
  type AuthProvider,
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { getExecutionPolicy } from './execution-policy';
import {
  assertOAuthEndpointUrl,
  createMcpOAuthFetch,
  type OAuthFetchLike,
} from './mcp-oauth-fetch';
import {
  DEFAULT_AUTHORIZATION_TIMEOUT_MS,
  LOOPBACK_CALLBACK_PATH,
  type LoopbackReceiver,
  startLoopbackReceiver,
} from './mcp-oauth-loopback';
import {
  clearMcpOAuthRecord,
  loadMcpOAuthRecord,
  type McpOAuthRecord,
  saveMcpOAuthRecord,
} from './mcp-oauth-store';
import { createSecretRedactor, type SecretRedactor } from './ws-handshake-auth';

/** Refresh this long before the recorded expiry. */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

const REAUTH_MESSAGE =
  'MCP authorization expired and could not be refreshed — reconnect to sign in again.';

/** Raised when re-authorization needs the browser but the session is non-interactive. */
export class McpOAuthReauthRequiredError extends Error {
  readonly reauthRequired = true;
  constructor(message = REAUTH_MESSAGE) {
    super(message);
    this.name = 'McpOAuthReauthRequiredError';
  }
}

export function isMcpOAuthReauthRequired(err: unknown): boolean {
  return (
    err instanceof McpOAuthReauthRequiredError ||
    (err instanceof Error && err.message.includes(REAUTH_MESSAGE))
  );
}

export interface McpOAuthConfig {
  /** The MCP server URL (the protected resource). */
  serverUrl: string;
  /** Pre-registered client id. Absent → RFC 7591 dynamic registration. */
  clientId?: string;
  /** Resolved (main-only) client secret for a confidential static client. */
  clientSecret?: string;
  /** Requested scope; the 401 challenge's / PRM's scope wins when absent. */
  scope?: string;
  /** Exact loopback redirect URI for an AS that requires a fixed one. */
  redirectUrl?: string;
}

export interface McpOAuthDeps {
  fetchFn?: OAuthFetchLike;
  openExternal?: (url: string) => Promise<void>;
  startReceiver?: typeof startLoopbackReceiver;
  now?: () => number;
  authorizationTimeoutMs?: number;
  /** Called while the user is in the browser (the connect timeout pauses). */
  onAuthorizationWait?: (waiting: boolean) => void;
}

/** Validate a user-supplied fixed redirect URI: loopback http with an explicit port. */
export function parseLoopbackRedirect(raw: string): { url: URL; port: number } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Redirect URI is not a valid URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || (host !== '127.0.0.1' && host !== 'localhost')) {
    throw new Error(
      'MCP OAuth redirect URI must be a loopback http://127.0.0.1:<port>/… address (RFC 8252)'
    );
  }
  if (!url.port) throw new Error('MCP OAuth redirect URI needs an explicit port');
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('MCP OAuth redirect URI must not carry a query, fragment or credentials');
  }
  return { url, port: Number(url.port) };
}

async function defaultOpenExternal(url: string): Promise<void> {
  const { shell } = await import('electron');
  await shell.openExternal(url, { activate: true });
}

function placeholderRedirect(): string {
  return `http://127.0.0.1${LOOPBACK_CALLBACK_PATH}`;
}

export class McpOAuthSession {
  /** Hand this to the MCP transport as `authProvider`. */
  readonly authProvider: AuthProvider;
  /** The SDK-facing OAuth client provider (exposed for tests). */
  readonly provider: OAuthClientProvider;
  /** Set once a refresh failed and the browser is needed (non-interactive). */
  reauthRequired = false;

  private interactive = true;
  private readonly abort = new AbortController();
  private readonly fetchFn: OAuthFetchLike;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly startReceiver: typeof startLoopbackReceiver;
  private readonly now: () => number;
  private readonly secrets = new Set<string>();
  private redactor: SecretRedactor = (text) => text;
  private inflight: Promise<void> | undefined;
  private redirect: string;
  private codeVerifierValue: string | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private receiver: LoopbackReceiver | undefined;
  private pendingCallback: Promise<URLSearchParams> | undefined;
  private record: McpOAuthRecord | undefined;

  constructor(
    private readonly config: McpOAuthConfig,
    private readonly deps: McpOAuthDeps = {}
  ) {
    if (config.redirectUrl) parseLoopbackRedirect(config.redirectUrl);
    this.fetchFn = deps.fetchFn ?? createMcpOAuthFetch({ signal: this.abort.signal });
    this.openExternal = deps.openExternal ?? defaultOpenExternal;
    this.startReceiver = deps.startReceiver ?? startLoopbackReceiver;
    this.now = deps.now ?? Date.now;
    this.record = loadMcpOAuthRecord(config.serverUrl, config.clientId);
    this.redirect =
      config.redirectUrl ?? this.record?.registeredRedirectUrl ?? placeholderRedirect();
    this.track(config.clientSecret);
    this.trackRecord(this.record);
    this.provider = this.buildProvider();
    this.authProvider = {
      token: () => this.currentToken(),
      onUnauthorized: async (ctx) => {
        const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
        await this.authorize({ resourceMetadataUrl, scope });
      },
    };
  }

  /** Scrub every token / secret / code this session has handled. */
  readonly redact = (text: string): string => this.redactor(text);

  /** After the initial connect, a lapsed session prompts instead of opening a browser. */
  endInteractive(): void {
    this.interactive = false;
  }

  dispose(): void {
    this.abort.abort();
    this.receiver?.close();
  }

  private track(value: string | undefined): void {
    if (!value || value.length < 4 || this.secrets.has(value)) return;
    this.secrets.add(value);
    this.redactor = createSecretRedactor(this.secrets);
  }

  private trackRecord(record: McpOAuthRecord | undefined): void {
    this.track(record?.tokens?.access_token);
    this.track(record?.tokens?.refresh_token);
    this.track(record?.registration?.client_secret);
  }

  private persist(patch: Parameters<typeof saveMcpOAuthRecord>[2]): void {
    this.record = saveMcpOAuthRecord(this.config.serverUrl, this.config.clientId, patch);
  }

  private buildProvider(): OAuthClientProvider {
    const session = this;
    const isStatic = Boolean(this.config.clientId);
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return session.redirect;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: 'Restura',
          redirect_uris: [session.redirect],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          // Public native client: PKCE, no client secret (RFC 8252 §8.4).
          token_endpoint_auth_method: 'none',
          ...(session.config.scope ? { scope: session.config.scope } : {}),
        };
      },
      state: () => {
        const state = crypto.randomBytes(32).toString('base64url');
        if (!session.interactive || !session.receiver) {
          session.reauthRequired = true;
          throw new McpOAuthReauthRequiredError();
        }
        // Arm before the browser opens so a fast callback can't be missed.
        session.pendingCallback = session.receiver.waitForCallback(state);
        session.pendingCallback.catch(() => undefined);
        return state;
      },
      clientInformation: (): StoredOAuthClientInformation | undefined => {
        if (isStatic) {
          return {
            client_id: session.config.clientId!,
            ...(session.config.clientSecret ? { client_secret: session.config.clientSecret } : {}),
          };
        }
        const reg = session.record?.registration;
        if (!reg) return undefined;
        // A DCR registration is bound to its redirect URI; a new loopback port
        // in an interactive flow means registering again.
        if (session.interactive && session.record?.registeredRedirectUrl !== session.redirect) {
          return undefined;
        }
        return reg;
      },
      tokens: () => session.record?.tokens,
      saveTokens: (tokens: StoredOAuthTokens) => {
        session.track(tokens.access_token);
        session.track(tokens.refresh_token);
        // Keep the old refresh token when the AS doesn't rotate it.
        const merged: StoredOAuthTokens = {
          ...tokens,
          ...(!tokens.refresh_token && session.record?.tokens?.refresh_token
            ? { refresh_token: session.record.tokens.refresh_token }
            : {}),
        };
        session.persist({
          tokens: merged,
          expiresAt:
            typeof tokens.expires_in === 'number'
              ? session.now() + tokens.expires_in * 1000
              : undefined,
        });
        session.reauthRequired = false;
      },
      redirectToAuthorization: async (authorizationUrl: URL) => {
        if (!session.interactive) {
          session.reauthRequired = true;
          throw new McpOAuthReauthRequiredError();
        }
        const url = assertOAuthEndpointUrl(authorizationUrl.href, getExecutionPolicy().security);
        session.deps.onAuthorizationWait?.(true);
        await session.openExternal(url.href);
      },
      saveCodeVerifier: (verifier: string) => {
        session.codeVerifierValue = verifier;
      },
      codeVerifier: () => {
        if (!session.codeVerifierValue) throw new Error('No PKCE code verifier for this flow');
        return session.codeVerifierValue;
      },
      saveDiscoveryState: (state: OAuthDiscoveryState) => {
        session.discovery = state;
      },
      discoveryState: () => session.discovery,
      invalidateCredentials: (scope) => {
        if (scope === 'all') {
          clearMcpOAuthRecord(session.config.serverUrl, session.config.clientId);
          session.record = undefined;
          session.codeVerifierValue = undefined;
          session.discovery = undefined;
          return;
        }
        if (scope === 'tokens') session.persist({ tokens: undefined, expiresAt: undefined });
        if (scope === 'client' && !isStatic) {
          session.persist({ registration: undefined, registeredRedirectUrl: undefined });
        }
        if (scope === 'verifier') session.codeVerifierValue = undefined;
        if (scope === 'discovery') session.discovery = undefined;
      },
    };
    if (!isStatic) {
      provider.saveClientInformation = (info: StoredOAuthClientInformation) => {
        session.track(info.client_secret);
        session.persist({ registration: info, registeredRedirectUrl: session.redirect });
      };
    }
    return provider;
  }

  private async currentToken(): Promise<string | undefined> {
    const tokens = this.record?.tokens;
    if (!tokens?.access_token) return undefined;
    const expiresAt = this.record?.expiresAt;
    if (expiresAt !== undefined && this.now() >= expiresAt - TOKEN_EXPIRY_SKEW_MS) {
      if (!tokens.refresh_token) return undefined; // let the 401 drive re-authorization
      await this.authorize({});
      return this.record?.tokens?.access_token;
    }
    return tokens.access_token;
  }

  /** Serialized: concurrent 401s (POST + GET SSE) share one flow. */
  authorize(opts: {
    resourceMetadataUrl?: URL | undefined;
    scope?: string | undefined;
  }): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.runAuthorize(opts).finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async openReceiver(): Promise<void> {
    const timeoutMs = this.deps.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
    const signal = this.abort.signal;
    if (this.config.redirectUrl) {
      const { url, port } = parseLoopbackRedirect(this.config.redirectUrl);
      try {
        this.receiver = await this.startReceiver({ port, path: url.pathname, timeoutMs, signal });
      } catch {
        throw new Error(
          `Could not listen on the configured OAuth redirect port ${port} — free it or change the redirect URI`
        );
      }
      this.redirect = this.config.redirectUrl;
      return;
    }
    // Reuse a DCR registration's port when it's free so the registration stays valid.
    const registered = this.record?.registeredRedirectUrl;
    const preferredPort = registered ? Number(new URL(registered).port) || 0 : 0;
    try {
      this.receiver = await this.startReceiver({ port: preferredPort, timeoutMs, signal });
    } catch {
      this.receiver = await this.startReceiver({ port: 0, timeoutMs, signal });
    }
    this.redirect = this.receiver.redirectUrl;
  }

  private async runAuthorize(opts: {
    resourceMetadataUrl?: URL | undefined;
    scope?: string | undefined;
  }): Promise<void> {
    if (this.abort.signal.aborted) throw new Error('MCP connection closed');
    this.record = loadMcpOAuthRecord(this.config.serverUrl, this.config.clientId) ?? this.record;
    const scope = opts.scope ?? this.config.scope;
    const base = {
      serverUrl: this.config.serverUrl,
      fetchFn: this.fetchFn,
      ...(scope ? { scope } : {}),
    };
    if (this.interactive) await this.openReceiver();
    try {
      const result = await auth(this.provider, {
        ...base,
        ...(opts.resourceMetadataUrl ? { resourceMetadataUrl: opts.resourceMetadataUrl } : {}),
      });
      if (result === 'AUTHORIZED') return;
      if (!this.pendingCallback) throw new Error('Authorization flow did not start');
      const params = await this.pendingCallback;
      this.deps.onAuthorizationWait?.(false);
      const code = params.get('code') ?? '';
      this.track(code);
      const iss = params.get('iss');
      const done = await auth(this.provider, {
        ...base,
        authorizationCode: code,
        ...(iss !== null ? { iss } : {}),
      });
      if (done !== 'AUTHORIZED') throw new Error('Authorization did not complete');
    } finally {
      this.deps.onAuthorizationWait?.(false);
      this.receiver?.close();
      this.receiver = undefined;
      this.pendingCallback = undefined;
      this.codeVerifierValue = undefined;
    }
  }
}
