import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '@/types';
import { buildMcpConnectAuth, pickMcpAuth } from '../mcpAuth';
import { McpClient } from '../mcpClient';

const identity = (text: string) => text;
const vars = (text: string) => text.replace('{{TOKEN}}', 'resolved-token');

function build(
  auth: AuthConfig | undefined,
  overrides: Partial<Parameters<typeof buildMcpConnectAuth>[0]> = {}
) {
  return buildMcpConnectAuth({
    auth,
    headers: { 'X-Trace': '1' },
    resolve: identity,
    desktop: false,
    ...overrides,
  });
}

describe('buildMcpConnectAuth — web harness (#896)', () => {
  it('reports a refused credential as a connect error', () => {
    const result = build({
      type: 'oauth2',
      oauth2: { accessToken: '}}', tokenType: '{{sec' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/variable reference/),
    });
  });

  it('passes headers through when there is no auth', () => {
    expect(build({ type: 'none' })).toEqual({ ok: true, headers: { 'X-Trace': '1' }, notices: [] });
    expect(build(undefined)).toMatchObject({ ok: true, headers: { 'X-Trace': '1' } });
  });

  it('applies an inline bearer token as an Authorization header, resolving {{vars}}', () => {
    const out = build(
      { type: 'bearer', bearer: { token: { kind: 'inline', value: '{{TOKEN}}' } } },
      { resolve: vars }
    );
    expect(out).toEqual({
      ok: true,
      headers: { 'X-Trace': '1', Authorization: 'Bearer resolved-token' },
      notices: [],
    });
  });

  it('applies an API key header and replaces a same-named user header (any casing)', () => {
    const out = build(
      { type: 'api-key', apiKey: { key: 'X-API-Key', value: 'k-123', in: 'header' } },
      { headers: { 'x-api-key': 'stale' } }
    );
    expect(out).toEqual({ ok: true, headers: { 'X-API-Key': 'k-123' }, notices: [] });
  });

  it('applies imported basic / oauth2 access-token auth as Authorization headers', () => {
    expect(build({ type: 'basic', basic: { username: 'u', password: 'p' } })).toMatchObject({
      ok: true,
      headers: { Authorization: `Basic ${btoa('u:p')}` },
    });
    expect(
      build({ type: 'oauth2', oauth2: { accessToken: 'at', tokenType: 'DPoP' } })
    ).toMatchObject({ ok: true, headers: { Authorization: 'DPoP at' } });
  });

  it('fails closed for a SecretRef handle (browser cannot resolve it)', () => {
    const out = build({ type: 'bearer', bearer: { token: { kind: 'handle', id: 'h1' } } });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/desktop app/);
  });

  it('fails closed with a re-entry hint when the credential is empty (e.g. after reload)', () => {
    const out = build({ type: 'bearer', bearer: { token: { kind: 'inline', value: '' } } });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/re-enter/);
  });

  it('sends basic with an empty username when a password is present, as the CLI does', () => {
    expect(build({ type: 'basic', basic: { username: '', password: 'p' } })).toMatchObject({
      ok: true,
      headers: { Authorization: `Basic ${btoa(':p')}` },
    });
  });

  it('forwards an empty-username basic to main on desktop, handle or inline', () => {
    for (const password of ['p', { kind: 'handle', id: 'h' } as const]) {
      const auth: AuthConfig = { type: 'basic', basic: { username: '', password } };
      expect(build(auth, { desktop: true })).toMatchObject({ ok: true, mainSideAuth: auth });
    }
  });

  it('refuses a handle password with no username on the web, as any other opaque secret', () => {
    const out = build({
      type: 'basic',
      basic: { username: '', password: { kind: 'handle', id: 'h' } },
    });
    expect(!out.ok && out.error).toMatch(/desktop app/);
  });

  it('fails closed for a missing API key header name or empty basic credentials', () => {
    expect(build({ type: 'api-key', apiKey: { key: ' ', value: 'v', in: 'header' } })).toEqual({
      ok: false,
      error: 'API Key auth needs a header name.',
    });
    const basic = build({ type: 'basic', basic: { username: '', password: '' } });
    expect(!basic.ok && basic.error).toMatch(/username or a password/);
  });

  it('fails closed for its own unsupported auth and for a query-string API key', () => {
    expect(build({ type: 'aws-signature' }).ok).toBe(false);
    const query = build({ type: 'api-key', apiKey: { key: 'k', value: 'v', in: 'query' } });
    expect(!query.ok && query.error).toMatch(/query string/);
  });

  it('refuses an API key header the MCP transport owns', () => {
    const out = build({
      type: 'api-key',
      apiKey: { key: 'Mcp-Session-Id', value: 'v', in: 'header' },
    });
    expect(!out.ok && out.error).toMatch(/reserved by the MCP transport/);
  });

  it('inherits supported folder auth and skips unsupported inherited auth with a notice', () => {
    const inherited = build(
      { type: 'none' },
      { inherited: { auth: { type: 'bearer', bearer: { token: 'folder' } }, sourceName: 'F' } }
    );
    expect(inherited).toMatchObject({ ok: true, headers: { Authorization: 'Bearer folder' } });

    const skipped = build(
      { type: 'none' },
      { inherited: { auth: { type: 'aws-signature' }, sourceName: 'Coll' } }
    );
    expect(skipped.ok).toBe(true);
    expect(skipped.ok && skipped.headers).toEqual({ 'X-Trace': '1' });
    expect(skipped.ok && skipped.notices[0]).toMatch(/Inherited AWS Signature auth from “Coll”/);
  });
});

describe('buildMcpConnectAuth — desktop harness', () => {
  it('defers a handle-backed credential to Electron main without building a header', () => {
    const out = build(
      { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h1', label: 'mcp' } } },
      { desktop: true }
    );
    expect(out).toEqual({
      ok: true,
      headers: { 'X-Trace': '1' },
      mainSideAuth: {
        type: 'bearer',
        bearer: { token: { kind: 'handle', id: 'h1', label: 'mcp' } },
      },
      notices: [],
    });
  });

  it('sends inline auth main-side too (one wire path), {{vars}} resolved, minimal fields', () => {
    const out = build(
      {
        type: 'api-key',
        apiKey: { key: 'X-Key', value: '{{TOKEN}}', in: 'header' },
        bearer: { token: 'unrelated-leftover' },
      },
      { desktop: true, resolve: vars }
    );
    expect(out.ok && out.mainSideAuth).toEqual({
      type: 'api-key',
      apiKey: { key: 'X-Key', value: 'resolved-token', in: 'header' },
    });
    expect(out.ok && out.headers).toEqual({ 'X-Trace': '1' });
  });

  it('still fails closed for an empty inline credential (no re-entry hint on desktop)', () => {
    const out = build({ type: 'bearer', bearer: { token: '' } }, { desktop: true });
    expect(out).toEqual({
      ok: false,
      error: 'Bearer auth is selected but its credential is empty.',
    });
  });

  it('accepts an external secret ref on desktop', () => {
    const out = build(
      {
        type: 'bearer',
        bearer: {
          token: {
            kind: 'external',
            provider: 'aws-secrets-manager',
            profileId: 'p',
            secretId: 's',
          },
        },
      },
      { desktop: true }
    );
    expect(out.ok).toBe(true);
  });
});

describe('pickMcpAuth', () => {
  it('keeps only the selected type’s fields and forces header placement', () => {
    expect(
      pickMcpAuth({
        type: 'api-key',
        apiKey: { key: 'k', value: 'v', in: 'query' },
        basic: { username: 'x', password: 'y' },
      })
    ).toEqual({ type: 'api-key', apiKey: { key: 'k', value: 'v', in: 'header' } });
    expect(pickMcpAuth({ type: 'oauth2', oauth2: { accessToken: 't' } })).toEqual({
      type: 'oauth2',
      oauth2: { accessToken: 't' },
    });
    expect(pickMcpAuth({ type: 'basic' })).toEqual({
      type: 'basic',
      basic: { username: '', password: '' },
    });
    expect(pickMcpAuth({ type: 'bearer' })).toEqual({ type: 'bearer', bearer: { token: '' } });
    expect(pickMcpAuth({ type: 'digest' })).toEqual({ type: 'none' });
  });
});

describe('McpClient auth wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as { electron?: unknown }).electron;
  });

  it('web: sends the applied credential as /api/mcp spec headers', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true, jsonRpc: { result: {} } }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = build({ type: 'bearer', bearer: { token: 'web-token' } });
    if (!auth.ok) throw new Error(auth.error);
    const client = new McpClient({
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
      headers: auth.headers,
      connectionId: 'c1',
    });
    await client.request('ping');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      headers: Record<string, string>;
    };
    expect(body.headers.Authorization).toBe('Bearer web-token');
  });

  it('desktop: forwards the auth descriptor (handle intact) on mcp:connect', async () => {
    const connect = vi.fn(async () => ({ success: true }));
    (window as { electron?: unknown }).electron = { isElectron: true, mcp: { connect } };
    const auth = build(
      { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h9' } } },
      { desktop: true }
    );
    if (!auth.ok) throw new Error(auth.error);
    const client = new McpClient({
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
      headers: auth.headers,
      ...(auth.mainSideAuth ? { auth: auth.mainSideAuth } : {}),
      connectionId: 'c2',
    });
    await expect(client.connect()).resolves.toEqual({ ok: true });
    expect(connect).toHaveBeenCalledWith({
      connectionId: 'c2',
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
      headers: { 'X-Trace': '1' },
      auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h9' } } },
    });
  });
});

describe('MCP OAuth 2.1 flow config (#856)', () => {
  const flowAuth: AuthConfig = {
    type: 'oauth2',
    oauth2: {
      accessToken: '',
      grantType: 'authorization_code',
      clientId: ' my-client ',
      clientSecret: { kind: 'handle', id: 'cs-1' },
      scope: 'mcp:tools',
      redirectUri: '',
      // Stale HTTP-flow fields must not cross IPC.
      tokenUrl: 'https://as.example.com/token',
      refreshToken: 'stale-refresh',
    },
  };

  it('web: fails closed with a desktop-only message (no token is ever minted in the browser)', () => {
    const out = build(flowAuth);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/desktop app/);
  });

  it('desktop: forwards only the flow configuration for Electron main', () => {
    const out = build(flowAuth, { desktop: true });
    expect(out).toEqual({
      ok: true,
      headers: { 'X-Trace': '1' },
      mainSideAuth: {
        type: 'oauth2',
        oauth2: {
          accessToken: '',
          grantType: 'authorization_code',
          clientId: 'my-client',
          clientSecret: { kind: 'handle', id: 'cs-1' },
          scope: 'mcp:tools',
        },
      },
      notices: [],
    });
  });

  it('desktop: forwards a fixed redirect URI and an inline client secret, drops an empty one', () => {
    const withRedirect = build(
      {
        type: 'oauth2',
        oauth2: {
          accessToken: '',
          grantType: 'authorization_code',
          clientId: 'c',
          clientSecret: { kind: 'inline', value: 's' },
          redirectUri: ' http://127.0.0.1:8765/cb ',
          issuer: ' https://as.example.com ',
        },
      },
      { desktop: true }
    );
    expect(withRedirect).toMatchObject({
      ok: true,
      mainSideAuth: {
        oauth2: {
          clientId: 'c',
          clientSecret: { kind: 'inline', value: 's' },
          redirectUri: 'http://127.0.0.1:8765/cb',
          issuer: 'https://as.example.com',
        },
      },
    });
    const emptySecret = build(
      {
        type: 'oauth2',
        oauth2: {
          accessToken: '',
          grantType: 'authorization_code',
          clientId: 'c',
          clientSecret: { kind: 'inline', value: '' },
        },
      },
      { desktop: true }
    );
    expect(emptySecret.ok && emptySecret.mainSideAuth?.oauth2?.clientSecret).toBeFalsy();
  });

  it('desktop: a dynamic-registration flow sends no client fields', () => {
    const out = build(
      {
        type: 'oauth2',
        oauth2: { accessToken: '', grantType: 'authorization_code', clientSecret: '' },
      },
      { desktop: true }
    );
    expect(out).toMatchObject({
      ok: true,
      mainSideAuth: {
        type: 'oauth2',
        oauth2: { accessToken: '', grantType: 'authorization_code' },
      },
    });
  });

  it('desktop: surfaces authRequired from main on connect and requests', async () => {
    const connect = vi.fn(async () => ({ success: false, error: 'expired', authRequired: true }));
    const request = vi.fn(async () => ({ success: false, error: 'expired', authRequired: true }));
    (window as { electron?: unknown }).electron = { isElectron: true, mcp: { connect, request } };
    const client = new McpClient({
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
      headers: {},
      connectionId: 'c3',
    });
    await expect(client.connect()).resolves.toEqual({
      ok: false,
      error: 'expired',
      authRequired: true,
    });
    await expect(client.request('tools/list')).resolves.toMatchObject({
      ok: false,
      authRequired: true,
    });
    delete (window as { electron?: unknown }).electron;
  });
});
