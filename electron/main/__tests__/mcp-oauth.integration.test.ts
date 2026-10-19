// @vitest-environment node

import * as net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IpcUtils from '../ipc/ipc-utils';

/**
 * #856: MCP OAuth 2.1 end to end through the real `mcp:connect` handler, a
 * real OAuth-protected MCP server (SDK McpServer) and a spec-shaped mock AS.
 * The system browser is simulated: `shell.openExternal` follows the
 * authorization URL and delivers the 302 to the loopback receiver.
 */

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const openExternal = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  shell: { openExternal },
}));
vi.mock('../ipc/ipc-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcUtils>();
  return { ...actual, emitTo: mockEmitTo };
});
vi.mock('../security/encrypted-key', () => ({
  getOrCreateEncryptedKey: vi.fn(() => 'test-encryption-key'),
  getKeyStoreStatus: vi.fn(() => ({ mode: 'safeStorage', plaintextStores: [] })),
}));

import {
  type MockOAuthServerHandle,
  startMockOAuthServer,
} from '../../../e2e/mocks/mcpOAuthServer';
import { type MockMcpServerHandle, startMockMcpServer } from '../../../e2e/mocks/mcpServer';
import { registerMcpHandlerIPC, stopMcpCleanup } from '../handlers/mcp-handler';
import { setExecutionPolicy } from '../security/execution-policy';
import { MCP_OAUTH_SECRET_SCOPE } from '../security/mcp-oauth-store';
import {
  __setSecretStoreForTests,
  resolveSecretHandle,
  storeSecretHandle,
} from '../security/secret-handle-store';

type IpcHandler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;

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

const trustedEvent = {
  sender: { id: 11, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};

const registered = new Map<string, IpcHandler>();
function ipc(channel: string, payload: unknown) {
  const handler = registered.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(trustedEvent, payload);
}

/** Simulated system browser: follow the AS redirect to the loopback receiver. */
async function browser(url: string): Promise<void> {
  const res = await fetch(url, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error(`authorize failed: ${res.status} ${await res.text()}`);
  const callback = await fetch(location);
  await callback.text();
}

function oauthAuth(extra: Record<string, unknown> = {}) {
  return { type: 'oauth2', oauth2: { accessToken: '', grantType: 'authorization_code', ...extra } };
}

let connSeq = 0;
async function connect(server: MockMcpServerHandle, auth: unknown) {
  const connectionId = `oauth-${++connSeq}`;
  const res = await ipc('mcp:connect', {
    connectionId,
    url: server.url,
    transport: 'streamable-http',
    auth,
  });
  return { res, connectionId };
}

/** Everything main sent back to the renderer (replies + events) as one string. */
function rendererTraffic(replies: unknown[]): string {
  return JSON.stringify([replies, mockEmitTo.mock.calls]);
}

describe('MCP OAuth 2.1 (main-side provider, real servers)', () => {
  let as: MockOAuthServerHandle;
  let mcp: MockMcpServerHandle;

  beforeAll(async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    registerMcpHandlerIPC();
    for (const [channel, handler] of mockHandle.mock.calls) {
      registered.set(channel as string, handler as IpcHandler);
    }
  });

  beforeEach(async () => {
    memory.clear();
    __setSecretStoreForTests(fakeStore);
    openExternal.mockReset();
    openExternal.mockImplementation(browser);
    mockEmitTo.mockReset();
  });

  afterEach(async () => {
    stopMcpCleanup();
    await mcp?.close();
    await as?.close();
  });

  afterAll(() => {
    __setSecretStoreForTests(null);
  });

  async function startPair(
    asOpts: Parameters<typeof startMockOAuthServer>[0] = {},
    mcpOverrides = {}
  ) {
    as = await startMockOAuthServer(asOpts);
    const asRef = as;
    mcp = await startMockMcpServer({
      oauth: {
        isAuthorized: (header) =>
          header.startsWith('Bearer ') && asRef.isValidAccessToken(header.slice(7)),
        authorizationServers: [as.url],
        ...mcpOverrides,
      },
    });
  }

  it('discovers PRM + AS metadata, registers dynamically, signs in with PKCE and calls tools', async () => {
    await startPair();
    const { res, connectionId } = await connect(mcp, oauthAuth());
    expect(res).toEqual({ success: true });

    // RFC 7591 registration with our loopback redirect, public client.
    expect(as.registrations).toHaveLength(1);
    const reg = as.registrations[0]!;
    expect(reg.token_endpoint_auth_method).toBe('none');
    expect((reg.redirect_uris as string[])[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/
    );

    // Browser opened exactly once with an S256 + resource-bound request.
    expect(openExternal).toHaveBeenCalledTimes(1);
    const authorize = as.authorizeRequests[0]!;
    expect(authorize.get('code_challenge_method')).toBe('S256');
    expect(authorize.get('resource')).toBe(mcp.url);
    expect(authorize.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // Token request: PKCE verifier + RFC 8707 resource.
    const tokenReq = as.tokenRequests.at(-1)!.params;
    expect(tokenReq.get('grant_type')).toBe('authorization_code');
    expect(tokenReq.get('code_verifier')).toBeTruthy();
    expect(tokenReq.get('resource')).toBe(mcp.url);

    const listed = await ipc('mcp:request', { connectionId, method: 'tools/list' });
    expect(listed.success).toBe(true);
    const accessToken = as.issuedAccessTokens.at(-1)!;
    expect(mcp.authorizationsReceived()).toContain(`Bearer ${accessToken}`);

    // Tokens live only in the encrypted handle store, under the internal scope …
    const records = [...memory.values()];
    expect(records).toHaveLength(1);
    expect(records[0]!.scope).toBe(MCP_OAUTH_SECRET_SCOPE);
    expect(records[0]!.value).toContain(accessToken);
    // … which a renderer-supplied handle ref can't resolve.
    expect(resolveSecretHandle([...memory.keys()][0]!)).toBeUndefined();

    // … and never reach the renderer.
    const traffic = rendererTraffic([res, listed]);
    for (const secret of [...as.issuedAccessTokens, ...as.issuedRefreshTokens]) {
      expect(traffic).not.toContain(secret);
    }

    const status = await ipc('mcp:oauth:status', { url: mcp.url });
    expect(status).toMatchObject({ signedIn: true, canRefresh: true, dynamicallyRegistered: true });
    expect(JSON.stringify(status)).not.toContain(accessToken);
  });

  it('reuses stored tokens on the next connect without opening the browser', async () => {
    await startPair();
    expect((await connect(mcp, oauthAuth())).res.success).toBe(true);
    stopMcpCleanup();
    openExternal.mockClear();

    const { res } = await connect(mcp, oauthAuth());
    expect(res.success).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(as.registrations).toHaveLength(1);
  });

  it('uses a static client id + keychain client secret instead of registering', async () => {
    await startPair({ staticClients: { 'restura-static': 's3cret-client-value' } });
    const { id } = storeSecretHandle({ value: 's3cret-client-value', label: 'client' });
    const { res } = await connect(
      mcp,
      oauthAuth({
        clientId: 'restura-static',
        clientSecret: { kind: 'handle', id },
        issuer: as.issuer,
      })
    );
    expect(res).toEqual({ success: true });
    expect(as.registrations).toHaveLength(0);
    expect(as.authorizeRequests[0]!.get('client_id')).toBe('restura-static');
    const tokenReq = as.tokenRequests.at(-1)!;
    const basic = Buffer.from('restura-static:s3cret-client-value').toString('base64');
    const authenticated =
      tokenReq.authorization === `Basic ${basic}` ||
      tokenReq.params.get('client_secret') === 's3cret-client-value';
    expect(authenticated).toBe(true);
    // The static secret is not copied into the OAuth record.
    const record = [...memory.values()].find((r) => r.scope === MCP_OAUTH_SECRET_SCOPE)!;
    expect(record.value).not.toContain('s3cret-client-value');
  });

  it('never sends a static client secret to an AS other than the configured issuer', async () => {
    // The MCP server's PRM names this (attacker-controlled) AS …
    await startPair({ staticClients: { 'restura-static': 'bound-client-secret' } });
    const { id } = storeSecretHandle({ value: 'bound-client-secret', label: 'client' });
    const { res } = await connect(
      mcp,
      oauthAuth({
        clientId: 'restura-static',
        clientSecret: { kind: 'handle', id },
        // … but the client is registered with another one.
        issuer: 'https://legit-as.example.com',
      })
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/MCP OAuth failed \(AuthorizationServerMismatchError\)/);
    expect(as.tokenRequests).toHaveLength(0);
    expect(as.authorizeRequests).toHaveLength(0);
    expect(openExternal).not.toHaveBeenCalled();
    expect(rendererTraffic([res])).not.toContain('bound-client-secret');
  });

  it('refuses a static client secret without an issuer', async () => {
    await startPair({ staticClients: { 'restura-static': 'unbound-secret' } });
    const { id } = storeSecretHandle({ value: 'unbound-secret', label: 'client' });
    const { res } = await connect(
      mcp,
      oauthAuth({ clientId: 'restura-static', clientSecret: { kind: 'handle', id } })
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/issuer/);
    expect(as.tokenRequests).toHaveLength(0);
  });

  it('sign-out ends a live session: the next request asks for a fresh sign-in', async () => {
    await startPair();
    const { res, connectionId } = await connect(mcp, oauthAuth());
    expect(res.success).toBe(true);
    openExternal.mockClear();
    expect(await ipc('mcp:oauth:signOut', { url: mcp.url })).toEqual({ success: true });
    const listed = await ipc('mcp:request', { connectionId, method: 'tools/list' });
    expect(listed.success).toBe(false);
    expect(listed.authRequired).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token with the refresh_token grant (no browser)', async () => {
    // expires_in 61s minus the 60s refresh skew → due for refresh after ~1s.
    await startPair({ expiresIn: 61 });
    expect((await connect(mcp, oauthAuth())).res.success).toBe(true);
    stopMcpCleanup();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    openExternal.mockClear();
    const issuedBefore = as.issuedAccessTokens.length;

    const { res, connectionId } = await connect(mcp, oauthAuth());
    expect(res.success).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(as.tokenRequests.some((t) => t.params.get('grant_type') === 'refresh_token')).toBe(true);
    expect(as.issuedAccessTokens.length).toBeGreaterThan(issuedBefore);
    const listed = await ipc('mcp:request', { connectionId, method: 'tools/list' });
    expect(listed.success).toBe(true);
  });

  it('refreshes at connect without opening the loopback receiver (pinned redirect port busy)', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port: p } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(p));
      });
    });
    await startPair({ expiresIn: 61 });
    const auth = oauthAuth({ redirectUri: `http://127.0.0.1:${port}/oauth/callback` });
    expect((await connect(mcp, auth)).res.success).toBe(true);
    stopMcpCleanup();
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      openExternal.mockClear();
      const { res } = await connect(mcp, auth);
      expect(res).toEqual({ success: true });
      expect(openExternal).not.toHaveBeenCalled();
      expect(as.tokenRequests.at(-1)!.params.get('grant_type')).toBe('refresh_token');
      expect(as.registrations).toHaveLength(1);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('signs in at connect when initialize is anonymous but later requests need a token', async () => {
    as = await startMockOAuthServer();
    const asRef = as;
    let anonymousAllowed = true;
    mcp = await startMockMcpServer({
      oauth: {
        isAuthorized: (header) =>
          anonymousAllowed ||
          (header.startsWith('Bearer ') && asRef.isValidAccessToken(header.slice(7))),
        authorizationServers: [as.url],
      },
    });
    const { res, connectionId } = await connect(mcp, oauthAuth());
    expect(res).toEqual({ success: true });
    expect(openExternal).toHaveBeenCalledTimes(1);

    anonymousAllowed = false;
    const listed = await ipc('mcp:request', { connectionId, method: 'tools/list' });
    expect(listed.success).toBe(true);
    expect(mcp.authorizationsReceived()).toContain(`Bearer ${as.issuedAccessTokens.at(-1)!}`);
  });

  it('surfaces a re-auth prompt (authRequired) when a mid-session refresh fails', async () => {
    await startPair();
    const { res, connectionId } = await connect(mcp, oauthAuth());
    expect(res.success).toBe(true);
    openExternal.mockClear();

    as.revokeAccessTokens();
    as.setFailRefresh(true);
    const listed = await ipc('mcp:request', { connectionId, method: 'tools/list' });
    expect(listed.success).toBe(false);
    expect(listed.authRequired).toBe(true);
    expect(String(listed.error)).toMatch(/sign in again/i);
    // Never pops a browser on its own mid-session.
    expect(openExternal).not.toHaveBeenCalled();
    expect(rendererTraffic([listed])).not.toContain(as.issuedRefreshTokens[0]!);
  });

  it('rejects an authorization server whose metadata issuer does not match (RFC 8414 §3.3)', async () => {
    await startPair({ issuerOverride: 'https://evil.example' });
    const { res } = await connect(mcp, oauthAuth());
    expect(res.success).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    expect(as.tokenRequests).toHaveLength(0);
  });

  it('refuses a resource_metadata URL aimed at a cloud-metadata endpoint (SSRF)', async () => {
    await startPair({}, { resourceMetadataUrl: 'http://169.254.169.254/latest/meta-data' });
    const { res } = await connect(mcp, oauthAuth());
    expect(res.success).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    expect(as.registrations).toHaveLength(0);
  });

  it('refuses a plain-http, non-loopback authorization server', async () => {
    as = await startMockOAuthServer();
    mcp = await startMockMcpServer({
      oauth: { isAuthorized: () => false, authorizationServers: ['http://auth.example.com'] },
    });
    const { res } = await connect(mcp, oauthAuth());
    expect(res.success).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('sign-out forgets the stored tokens so the next connect signs in again', async () => {
    await startPair();
    expect((await connect(mcp, oauthAuth())).res.success).toBe(true);
    expect(await ipc('mcp:oauth:signOut', { url: mcp.url })).toEqual({ success: true });
    expect(memory.size).toBe(0);
    expect(await ipc('mcp:oauth:status', { url: mcp.url })).toMatchObject({ signedIn: false });
  });
});
