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

import { replaceSecretVariableTokens } from '../security/secret-variable-materializer';
import { materializeWsHandshakeAuth } from '../security/ws-handshake-auth';

const handle = (id: string) => ({ kind: 'handle' as const, id });
type Auth = Parameters<typeof materializeWsHandshakeAuth>[0]['auth'];

describe('materializeWsHandshakeAuth', () => {
  it('is a no-op without auth or secret variables', async () => {
    const out = await materializeWsHandshakeAuth({ url: 'wss://a.example/x' });
    expect(out).toMatchObject({ url: 'wss://a.example/x', headers: {} });
    expect(out.redact('anything')).toBe('anything');
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
    ).resolves.toMatchObject({ url: 'wss://a.example/x', headers: {} });
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

  describe('fail-closed + hygiene (security review)', () => {
    it.each([
      ['bearer', { type: 'bearer', bearer: { token: handle('revoked') } }],
      ['basic', { type: 'basic', basic: { username: '', password: handle('revoked') } }],
      ['api-key', { type: 'api-key', apiKey: { key: 'k', value: handle('revoked'), in: 'query' } }],
      ['oauth2', { type: 'oauth2', oauth2: { accessToken: handle('revoked') } }],
      ['digest (never header-shaped)', { type: 'digest' }],
    ])('refuses to open unauthenticated when %s resolves to nothing', async (_n, auth) => {
      await expect(
        materializeWsHandshakeAuth({ url: 'wss://a.example/x', auth: auth as Auth })
      ).rejects.toThrow('Auth credential is unavailable on this device');
    });

    it('treats auth type none as nothing to apply', async () => {
      await expect(
        materializeWsHandshakeAuth({ url: 'wss://a.example/x', auth: { type: 'none' } as Auth })
      ).resolves.toMatchObject({ headers: {} });
    });

    it('rejects CRLF in a secret-derived header value without echoing the value', async () => {
      const err = await materializeWsHandshakeAuth({
        url: 'wss://a.example/x',
        headers: { 'X-Secret': '{{s}}' },
        secretVariables: { s: { kind: 'inline', value: 'top\r\nX-Injected: secret-crlf' } },
      }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('Header "X-Secret" contains invalid characters');
      expect((err as Error).message).not.toContain('secret-crlf');
    });

    it('rejects CRLF in a handle-backed bearer token', async () => {
      HANDLES['h-crlf'] = 'tok\nevil';
      await expect(
        materializeWsHandshakeAuth({
          url: 'wss://a.example/x',
          auth: { type: 'bearer', bearer: { token: handle('h-crlf') } } as Auth,
        })
      ).rejects.toThrow('Header "Authorization" contains invalid characters');
    });

    it.each([
      'Sec-WebSocket-Protocol',
      'Sec-WebSocket-Extensions',
      'sec-websocket-key',
      'Proxy-Authorization',
      'Upgrade',
    ])('rejects an API-key header named %s', async (key) => {
      await expect(
        materializeWsHandshakeAuth({
          url: 'wss://a.example/x',
          auth: {
            type: 'api-key',
            apiKey: { key, value: handle('h-token'), in: 'header' },
          } as Auth,
        })
      ).rejects.toThrow(/not allowed on a WebSocket handshake/);
    });

    it('replaces a case-duplicate user Authorization header instead of sending two', async () => {
      const out = await materializeWsHandshakeAuth({
        url: 'wss://a.example/x',
        headers: { authorization: 'Bearer user-typed', AUTHORIZATION: 'x' },
        auth: { type: 'bearer', bearer: { token: handle('h-token') } } as Auth,
      });
      expect(out.headers).toEqual({ Authorization: 'Bearer keychain-token' });
    });

    it('substitutes secret variables inside inline SecretRef auth values', async () => {
      const vars = { tok: handle('h-token'), pass: handle('h-pass') };
      const bearer = await materializeWsHandshakeAuth({
        url: 'wss://a.example/x',
        auth: { type: 'bearer', bearer: { token: { kind: 'inline', value: '{{tok}}' } } } as Auth,
        secretVariables: vars,
      });
      expect(bearer.headers.Authorization).toBe('Bearer keychain-token');

      const basic = await materializeWsHandshakeAuth({
        url: 'wss://a.example/x',
        auth: {
          type: 'basic',
          basic: { username: 'u', password: { kind: 'inline', value: 'x-{{ pass }}' } },
        } as Auth,
        secretVariables: vars,
      });
      expect(basic.headers.Authorization).toBe(
        `Basic ${Buffer.from('u:x-keychain-pass').toString('base64')}`
      );
      expect(basic.redact('x-keychain-pass')).toBe('[redacted]');

      const apiKey = await materializeWsHandshakeAuth({
        url: 'wss://a.example/x',
        auth: {
          type: 'api-key',
          apiKey: { key: 'k', value: { kind: 'inline', value: '{{tok}}' }, in: 'query' },
        } as Auth,
        secretVariables: vars,
      });
      expect(apiKey.url).toBe('wss://a.example/x?k=keychain-token');
    });

    it('never substitutes secret variables into the API key NAME', async () => {
      await expect(
        materializeWsHandshakeAuth({
          url: 'wss://a.example/x',
          auth: { type: 'api-key', apiKey: { key: '{{name}}', value: 'v', in: 'header' } } as Auth,
          secretVariables: { name: { kind: 'inline', value: 'Host' } },
        })
      ).resolves.toMatchObject({ headers: { '{{name}}': 'v' } });
    });

    it('does not resolve inherited Object.prototype members as variables', async () => {
      const out = await materializeWsHandshakeAuth({
        url: 'wss://a.example/{{constructor}}/{{toString}}/{{__proto__}}',
        secretVariables: { real: { kind: 'inline', value: 'r' } },
      });
      expect(out.url).toBe('wss://a.example/{{constructor}}/{{toString}}/{{__proto__}}');
      expect(out.url).not.toContain('function');
    });

    it('stops when aborted before applying credentials', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(
        materializeWsHandshakeAuth(
          { url: 'wss://a.example/x', secretVariables: { s: { kind: 'inline', value: 'v' } } },
          ctrl.signal
        )
      ).rejects.toThrow();
    });

    it('redact scrubs raw, URI- and form-encoded plaintext (Basic password included)', async () => {
      const out = await materializeWsHandshakeAuth({
        url: 'wss://a.example/x',
        auth: { type: 'basic', basic: { username: 'u', password: 'p@ss word&1' } } as Auth,
        secretVariables: { s: { kind: 'inline', value: 'host-secret' } },
      });
      const leak = `p@ss word&1 ${encodeURIComponent('p@ss word&1')} p%40ss+word%261 host-secret ${Buffer.from('u:p@ss word&1').toString('base64')}`;
      const scrubbed = out.redact(leak);
      expect(scrubbed).not.toMatch(/p@ss|p%40ss|host-secret/);
      expect(scrubbed).not.toContain(Buffer.from('u:p@ss word&1').toString('base64'));
    });
  });
});

describe('replaceSecretVariableTokens', () => {
  it('only resolves own properties', () => {
    expect(replaceSecretVariableTokens('{{constructor}}-{{a}}', { a: '1' })).toBe(
      '{{constructor}}-1'
    );
    const values = Object.create(null) as Record<string, string>;
    const ownKey: string = 'constructor';
    values[ownKey] = 'own';
    expect(replaceSecretVariableTokens('{{constructor}}', values)).toBe('own');
  });
});
