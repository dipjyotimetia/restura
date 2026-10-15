// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// Handle store stand-in: handle ids resolve to plaintext only here, in "main".
const HANDLES: Record<string, string> = {
  'h-token': 'keychain-token',
  'h-pass': 'keychain-pass',
  'h-host': 'api.example.com',
};
vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    const ref = v as { kind?: string; value?: string; id?: string } | undefined;
    if (ref?.kind === 'inline') return ref.value;
    if (ref?.kind === 'handle') return ref.id ? HANDLES[ref.id] : undefined;
    return undefined;
  },
}));
vi.mock('../security/external-secret-providers', () => ({
  desktopExternalSecretResolver: {
    resolve: vi.fn(async (ref: { secretId: string }) => `vault:${ref.secretId}`),
  },
}));

import { materializeWsHandshakeAuth } from '../security/ws-handshake-auth';

const handle = (id: string) => ({ kind: 'handle' as const, id });
type Auth = Parameters<typeof materializeWsHandshakeAuth>[0]['auth'];

describe('materializeWsHandshakeAuth', () => {
  it('is a no-op without auth or secret variables', async () => {
    expect(await materializeWsHandshakeAuth({ url: 'wss://a.example/x' })).toEqual({
      url: 'wss://a.example/x',
      headers: {},
    });
  });

  it('resolves a handle-backed Bearer into the handshake headers', async () => {
    const out = await materializeWsHandshakeAuth({
      url: 'wss://api.example.com/graphql',
      headers: { 'X-Tenant': 'acme' },
      auth: { type: 'bearer', bearer: { token: handle('h-token') } } as Auth,
    });
    expect(out.headers).toEqual({ 'X-Tenant': 'acme', Authorization: 'Bearer keychain-token' });
    expect(out.url).toBe('wss://api.example.com/graphql');
  });

  it('resolves handle-backed Basic', async () => {
    const out = await materializeWsHandshakeAuth({
      url: 'wss://api.example.com/graphql',
      auth: { type: 'basic', basic: { username: 'u', password: handle('h-pass') } } as Auth,
    });
    expect(out.headers.Authorization).toBe(
      `Basic ${Buffer.from('u:keychain-pass').toString('base64')}`
    );
  });

  it('appends a handle-backed query API key to the URL', async () => {
    const out = await materializeWsHandshakeAuth({
      url: 'wss://api.example.com/graphql?v=1',
      auth: {
        type: 'api-key',
        apiKey: { key: 'api_key', value: handle('h-token'), in: 'query' },
      } as Auth,
    });
    expect(out.url).toBe('wss://api.example.com/graphql?v=1&api_key=keychain-token');
    expect(out.headers).toEqual({});
  });

  it('resolves external-vault OAuth2 tokens', async () => {
    const out = await materializeWsHandshakeAuth({
      url: 'wss://api.example.com/graphql',
      auth: {
        type: 'oauth2',
        oauth2: {
          accessToken: {
            kind: 'external',
            provider: 'aws-secrets-manager',
            profileId: 'p',
            secretId: 'tok',
          },
        },
      } as Auth,
    });
    expect(out.headers.Authorization).toBe('Bearer vault:tok');
  });

  it('substitutes secret variables into url, headers and auth fields', async () => {
    const out = await materializeWsHandshakeAuth({
      url: 'wss://{{host}}/graphql',
      headers: { 'X-Secret': '{{token}}', 'X-Plain': 'p' },
      auth: {
        type: 'basic',
        basic: { username: 'u', password: '{{pass}}' },
      } as Auth,
      secretVariables: { host: handle('h-host'), token: handle('h-token'), pass: handle('h-pass') },
    });
    expect(out.url).toBe('wss://api.example.com/graphql');
    expect(out.headers['X-Secret']).toBe('keychain-token');
    expect(out.headers['X-Plain']).toBe('p');
    expect(out.headers.Authorization).toBe(
      `Basic ${Buffer.from('u:keychain-pass').toString('base64')}`
    );
  });

  it('substitutes secret variables into bearer / api-key / oauth2 fields', async () => {
    const vars = { t: handle('h-token') };
    const bearer = await materializeWsHandshakeAuth({
      url: 'wss://a.example/x',
      auth: { type: 'bearer', bearer: { token: '{{t}}' } } as Auth,
      secretVariables: vars,
    });
    expect(bearer.headers.Authorization).toBe('Bearer keychain-token');
    const apiKey = await materializeWsHandshakeAuth({
      url: 'wss://a.example/x',
      auth: { type: 'api-key', apiKey: { key: 'X-Key', value: '{{t}}', in: 'header' } } as Auth,
      secretVariables: vars,
    });
    expect(apiKey.headers['X-Key']).toBe('keychain-token');
    const oauth = await materializeWsHandshakeAuth({
      url: 'wss://a.example/x',
      auth: { type: 'oauth2', oauth2: { accessToken: '{{t}}', tokenType: 'MAC' } } as Auth,
      secretVariables: vars,
    });
    expect(oauth.headers.Authorization).toBe('MAC keychain-token');
  });

  it('fails (naming the variable, not a value) when a secret is unavailable', async () => {
    await expect(
      materializeWsHandshakeAuth({
        url: 'wss://a.example/x',
        secretVariables: { gone: handle('missing') },
      })
    ).rejects.toThrow(/Secret variable "gone" is unavailable/);
  });

  it('rejects an auth header the WS handshake must not carry', async () => {
    await expect(
      materializeWsHandshakeAuth({
        url: 'wss://a.example/x',
        auth: { type: 'api-key', apiKey: { key: 'Host', value: 'evil', in: 'header' } } as Auth,
      })
    ).rejects.toThrow(/not allowed on a WebSocket handshake/);
  });

  it('re-validates the final URL scheme after secret substitution', async () => {
    await expect(
      materializeWsHandshakeAuth({
        url: 'wss://a.example/{{p}}',
        secretVariables: { p: { kind: 'inline', value: 'x' } },
      })
    ).resolves.toEqual({ url: 'wss://a.example/x', headers: {} });
    await expect(
      materializeWsHandshakeAuth({
        url: '{{u}}',
        secretVariables: { u: { kind: 'inline', value: 'http://internal/' } },
      })
    ).rejects.toThrow(/Only ws: and wss:/);
    await expect(
      materializeWsHandshakeAuth({
        url: '{{u}}',
        secretVariables: { u: { kind: 'inline', value: 'not a url' } },
      })
    ).rejects.toThrow(/Invalid WebSocket URL/);
  });
});
