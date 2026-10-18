// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #856 unit coverage for the main-side MCP OAuth provider: config validation,
 * credential storage (internal SecretRef scope only), redaction of every
 * token / secret / code, invalidation, and the non-interactive re-auth rule.
 */

const openExternal = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openExternal },
}));
vi.mock('../security/encrypted-key', () => ({
  getOrCreateEncryptedKey: vi.fn(() => 'k'),
  getKeyStoreStatus: vi.fn(() => ({ mode: 'safeStorage', plaintextStores: [] })),
}));

import { createMcpOAuthSession } from '../security/mcp-oauth-connect';
import {
  isMcpOAuthReauthRequired,
  McpOAuthReauthRequiredError,
  McpOAuthSession,
  parseLoopbackRedirect,
} from '../security/mcp-oauth-provider';
import {
  canonicalMcpResource,
  loadMcpOAuthRecord,
  MCP_OAUTH_SECRET_SCOPE,
  mcpOAuthHandleId,
  mcpOAuthStatus,
  saveMcpOAuthRecord,
} from '../security/mcp-oauth-store';
import {
  __setSecretStoreForTests,
  INTERNAL_SECRET_SCOPE_PREFIX,
  resolveInternalSecretHandle,
  resolveSecretHandle,
  storeInternalSecretHandle,
  storeSecretHandle,
  unwrapSecretValueMain,
} from '../security/secret-handle-store';

const memory = new Map<string, { value: string; scope?: string; createdAt: number }>();
const fakeStore = {
  get: (key: string) => memory.get(key) as never,
  set: (key: string, value: unknown) => void memory.set(key, value as never),
  delete: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
  has: (key: string) => memory.has(key),
  get store() {
    return Object.fromEntries(memory.entries()) as never;
  },
};

const SERVER = 'https://mcp.example.com/mcp?tenant=1';
const noFetch = vi.fn(async () => {
  throw new Error('network disabled in unit tests');
});

beforeEach(() => {
  memory.clear();
  __setSecretStoreForTests(fakeStore);
  openExternal.mockReset();
});
afterAll(() => __setSecretStoreForTests(null));

describe('mcp-oauth-store', () => {
  it('binds records to origin + path and a UUID-shaped deterministic id', () => {
    expect(canonicalMcpResource(SERVER)).toBe('https://mcp.example.com/mcp');
    const id = mcpOAuthHandleId(SERVER, undefined);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mcpOAuthHandleId('https://mcp.example.com/mcp', undefined)).toBe(id);
    expect(mcpOAuthHandleId(SERVER, 'static')).not.toBe(id);
    expect(mcpOAuthHandleId('https://other.example.com/mcp', undefined)).not.toBe(id);
  });

  it('stores under the internal scope, unreachable through renderer handle refs', () => {
    saveMcpOAuthRecord(SERVER, undefined, {
      tokens: { access_token: 'at-123456', token_type: 'Bearer', refresh_token: 'rt-123456' },
      expiresAt: 42,
    });
    const id = mcpOAuthHandleId(SERVER, undefined);
    expect(memory.get(id)?.scope).toBe(MCP_OAUTH_SECRET_SCOPE);
    expect(resolveSecretHandle(id)).toBeUndefined();
    expect(unwrapSecretValueMain({ kind: 'handle', id })).toBeUndefined();
    expect(resolveInternalSecretHandle(id, 'internal:other')).toBeUndefined();
    expect(loadMcpOAuthRecord(SERVER, undefined)?.tokens?.access_token).toBe('at-123456');
    // A record saved for a static client is not the DCR record and vice versa.
    expect(loadMcpOAuthRecord(SERVER, 'static')).toBeUndefined();
    expect(mcpOAuthStatus(SERVER, undefined)).toEqual({
      signedIn: true,
      canRefresh: true,
      expiresAt: 42,
      dynamicallyRegistered: false,
    });
  });

  it('ignores a corrupted or mismatched record', () => {
    const id = mcpOAuthHandleId(SERVER, undefined);
    storeInternalSecretHandle({ id, value: '{not json', scope: MCP_OAUTH_SECRET_SCOPE });
    expect(loadMcpOAuthRecord(SERVER, undefined)).toBeUndefined();
    storeInternalSecretHandle({
      id,
      value: JSON.stringify({ v: 1, resource: 'https://elsewhere/mcp', updatedAt: 1 }),
      scope: MCP_OAUTH_SECRET_SCOPE,
    });
    expect(loadMcpOAuthRecord(SERVER, undefined)).toBeUndefined();
  });

  it('refuses a non-internal scope for internal writes', () => {
    expect(() => storeInternalSecretHandle({ id: 'x', value: 'v', scope: 'mcp' })).toThrow(
      INTERNAL_SECRET_SCOPE_PREFIX
    );
  });
});

describe('parseLoopbackRedirect', () => {
  it('accepts loopback http with an explicit port', () => {
    expect(parseLoopbackRedirect('http://127.0.0.1:8765/callback').port).toBe(8765);
    expect(parseLoopbackRedirect('http://localhost:8765/cb').port).toBe(8765);
  });
  it.each([
    'https://127.0.0.1:8765/cb',
    'http://example.com:8765/cb',
    'http://127.0.0.1/cb',
    'http://127.0.0.1:8765/cb?x=1',
    'http://127.0.0.1:8765/cb#f',
    'http://u:p@127.0.0.1:8765/cb',
    'nope',
  ])('rejects %s', (raw) => {
    expect(() => parseLoopbackRedirect(raw)).toThrow();
  });
});

describe('createMcpOAuthSession (connect-time config)', () => {
  const auth = (o: Record<string, unknown>) => ({ oauth2: o });

  it('rejects malformed client ids, scopes and redirect URIs', () => {
    expect(() => createMcpOAuthSession(SERVER, auth({ clientId: 'bad id' }))).toThrow(/client id/);
    expect(() => createMcpOAuthSession(SERVER, auth({ scope: 'a  b' }))).toThrow(/scope/);
    expect(() => createMcpOAuthSession(SERVER, auth({ scope: 'a"b' }))).toThrow(/scope/);
    expect(() =>
      createMcpOAuthSession(SERVER, auth({ redirectUri: 'https://evil.example/cb' }))
    ).toThrow(/loopback/);
  });

  it('needs a client id for a client secret, resolves handles, refuses missing / external ones', () => {
    expect(() => createMcpOAuthSession(SERVER, auth({ clientSecret: 'shh-secret' }))).toThrow(
      /needs a client id/
    );
    expect(() =>
      createMcpOAuthSession(
        SERVER,
        auth({ clientId: 'c', clientSecret: { kind: 'handle', id: 'missing' } })
      )
    ).toThrow(/unavailable/);
    expect(() =>
      createMcpOAuthSession(
        SERVER,
        auth({ clientId: 'c', clientSecret: { kind: 'external', provider: 'vault', ref: 'x' } })
      )
    ).toThrow(/External-vault/);
    const { id } = storeSecretHandle({ value: 'client-secret-value' });
    const session = createMcpOAuthSession(
      SERVER,
      auth({ clientId: 'c', clientSecret: { kind: 'handle', id }, scope: 'mcp:read mcp:write' }),
      { fetchFn: noFetch }
    );
    expect(session.redact('x client-secret-value y')).toBe('x [redacted] y');
    const info = session.provider.clientInformation() as {
      client_id: string;
      client_secret?: string;
    };
    expect(info).toEqual({ client_id: 'c', client_secret: 'client-secret-value' });
    expect(session.provider.clientMetadata.scope).toBe('mcp:read mcp:write');
    session.dispose();
  });
});

describe('McpOAuthSession', () => {
  it('redacts stored + newly saved tokens, DCR secrets and keeps a non-rotated refresh token', async () => {
    saveMcpOAuthRecord(SERVER, undefined, {
      tokens: {
        access_token: 'old-access-1',
        token_type: 'Bearer',
        refresh_token: 'old-refresh-1',
      },
    });
    const session = new McpOAuthSession(
      { serverUrl: SERVER },
      { fetchFn: noFetch, now: () => 1000 }
    );
    expect(session.redact('old-access-1 / old-refresh-1')).toBe('[redacted] / [redacted]');

    await session.provider.saveTokens({
      access_token: 'new-access-2',
      token_type: 'Bearer',
      expires_in: 10,
    });
    expect(session.redact('Bearer new-access-2')).toBe('Bearer [redacted]');
    const record = loadMcpOAuthRecord(SERVER, undefined)!;
    expect(record.tokens?.refresh_token).toBe('old-refresh-1');
    expect(record.expiresAt).toBe(11_000);

    await session.provider.saveClientInformation!({
      client_id: 'dcr',
      client_secret: 'dcr-secret-3',
    });
    expect(session.redact('dcr-secret-3')).toBe('[redacted]');
    expect(loadMcpOAuthRecord(SERVER, undefined)?.registration?.client_id).toBe('dcr');
    session.dispose();
  });

  it('serves the current token, and none once expired without a refresh token', async () => {
    let now = 0;
    saveMcpOAuthRecord(SERVER, undefined, {
      tokens: { access_token: 'tok-abcdef', token_type: 'Bearer' },
      expiresAt: 120_000,
    });
    const session = new McpOAuthSession(
      { serverUrl: SERVER },
      { fetchFn: noFetch, now: () => now }
    );
    expect(await session.authProvider.token()).toBe('tok-abcdef');
    now = 70_000; // inside the 60 s skew
    expect(await session.authProvider.token()).toBeUndefined();
    session.dispose();
  });

  it('invalidates tokens / client / all as the SDK asks', async () => {
    saveMcpOAuthRecord(SERVER, undefined, {
      tokens: { access_token: 'tok-abcdef', token_type: 'Bearer' },
      registration: { client_id: 'dcr' },
      registeredRedirectUrl: 'http://127.0.0.1:1234/oauth/callback',
    });
    const session = new McpOAuthSession({ serverUrl: SERVER }, { fetchFn: noFetch });
    await session.provider.saveCodeVerifier('v');
    expect(await session.provider.codeVerifier()).toBe('v');
    await session.provider.invalidateCredentials!('verifier');
    expect(() => session.provider.codeVerifier()).toThrow(/verifier/);
    await session.provider.saveDiscoveryState!({ authorizationServerUrl: 'https://as' });
    await session.provider.invalidateCredentials!('discovery');
    expect(await session.provider.discoveryState!()).toBeUndefined();
    await session.provider.invalidateCredentials!('tokens');
    expect(loadMcpOAuthRecord(SERVER, undefined)?.tokens).toBeUndefined();
    await session.provider.invalidateCredentials!('client');
    expect(loadMcpOAuthRecord(SERVER, undefined)?.registration).toBeUndefined();
    await session.provider.invalidateCredentials!('all');
    expect(loadMcpOAuthRecord(SERVER, undefined)).toBeUndefined();
    session.dispose();
  });

  it('a static client never stores or drops a registration', async () => {
    const session = new McpOAuthSession(
      { serverUrl: SERVER, clientId: 'static' },
      { fetchFn: noFetch }
    );
    expect(session.provider.saveClientInformation).toBeUndefined();
    await session.provider.invalidateCredentials!('client');
    expect(session.provider.clientInformation()).toEqual({ client_id: 'static' });
    session.dispose();
  });

  it('never opens the browser once non-interactive — raises the re-auth error instead', async () => {
    const session = new McpOAuthSession({ serverUrl: SERVER }, { fetchFn: noFetch });
    session.endInteractive();
    await expect(
      session.provider.redirectToAuthorization(new URL('https://as.example.com/authorize'))
    ).rejects.toBeInstanceOf(McpOAuthReauthRequiredError);
    expect(() => session.provider.state!()).toThrow(McpOAuthReauthRequiredError);
    expect(session.reauthRequired).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    session.dispose();
  });

  it('validates the authorization URL before opening it', async () => {
    const opened: string[] = [];
    const waits: boolean[] = [];
    const session = new McpOAuthSession(
      { serverUrl: SERVER },
      {
        fetchFn: noFetch,
        openExternal: async (url) => void opened.push(url),
        onAuthorizationWait: (w) => void waits.push(w),
      }
    );
    await expect(
      session.provider.redirectToAuthorization(new URL('http://evil.example.com/authorize'))
    ).rejects.toThrow(/https/);
    await expect(
      session.provider.redirectToAuthorization(new URL('javascript:alert(1)'))
    ).rejects.toThrow();
    await session.provider.redirectToAuthorization(new URL('https://as.example.com/authorize?x=1'));
    expect(opened).toEqual(['https://as.example.com/authorize?x=1']);
    expect(waits).toEqual([true]);
    session.dispose();
  });

  it('fails clearly when a fixed redirect port is taken', async () => {
    const session = new McpOAuthSession(
      { serverUrl: SERVER, clientId: 'c', redirectUrl: 'http://127.0.0.1:65000/cb' },
      {
        fetchFn: noFetch,
        startReceiver: async () => {
          throw new Error('EADDRINUSE');
        },
      }
    );
    await expect(session.authorize({})).rejects.toThrow(/redirect port 65000/);
    session.dispose();
  });

  it('refuses to authorize after dispose', async () => {
    const session = new McpOAuthSession({ serverUrl: SERVER }, { fetchFn: noFetch });
    session.dispose();
    await expect(session.authorize({})).rejects.toThrow(/closed/);
  });

  it('recognises the re-auth error by type and message', () => {
    expect(isMcpOAuthReauthRequired(new McpOAuthReauthRequiredError())).toBe(true);
    expect(isMcpOAuthReauthRequired(new Error(new McpOAuthReauthRequiredError().message))).toBe(
      true
    );
    expect(isMcpOAuthReauthRequired(new Error('other'))).toBe(false);
  });
});
