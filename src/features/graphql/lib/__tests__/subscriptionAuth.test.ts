/**
 * #878 / #882 — GraphQL subscriptions use the same effective auth as queries:
 * inherited auth, {{vars}} resolved, API-key-in-query on the socket URL, and
 * SecretRef handles / secret variables resolved main-side on desktop (never in
 * the renderer) or reported as unapplied on web.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { AuthConfig, Collection, HttpRequest } from '@/types';
import {
  buildSubscriptionHandshake,
  prepareSubscriptionHandshake,
  type SubscriptionHandshakeInput,
} from '../subscriptionAuth';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'req-1',
    name: 'sub',
    type: 'http',
    method: 'POST',
    url: 'https://{{host}}/graphql',
    headers: [
      { id: 'h1', key: 'X-Tenant', value: '{{tenant}}', enabled: true },
      { id: 'h2', key: 'X-Off', value: 'nope', enabled: false },
    ],
    params: [],
    body: { type: 'graphql', raw: 'subscription { tick }' },
    auth: { type: 'none' },
    ...overrides,
  };
}

function input(overrides: Partial<SubscriptionHandshakeInput> = {}): SubscriptionHandshakeInput {
  return {
    request: request(),
    values: { host: 'api.example.com', tenant: 'acme', token: 'tok-123', user: 'alice' },
    secretVariables: {},
    resolveVariables: (text) => text.replace('{{dyn}}', 'dynamic'),
    desktop: false,
    ...overrides,
  };
}

const handle = { kind: 'handle', id: 'handle-1' } as const;

describe('buildSubscriptionHandshake — {{vars}} and inheritance (#878)', () => {
  it('resolves {{vars}} in the URL, headers and bearer token', () => {
    const hs = buildSubscriptionHandshake(
      input({
        request: request({ auth: { type: 'bearer', bearer: { token: '{{token}}' } } }),
      })
    );
    expect(hs.url).toBe('https://api.example.com/graphql');
    expect(hs.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Tenant': 'acme',
      Authorization: 'Bearer tok-123',
    });
    expect(hs.connectionParams).toEqual(hs.headers);
    expect(hs.mainSide).toBeUndefined();
    expect(hs.unapplied).toEqual([]);
  });

  it('applies the store resolver after request-scope values', () => {
    const hs = buildSubscriptionHandshake(
      input({ request: request({ auth: { type: 'bearer', bearer: { token: '{{dyn}}' } } }) })
    );
    expect(hs.headers.Authorization).toBe('Bearer dynamic');
  });

  it('resolves {{vars}} in Basic username/password', () => {
    const hs = buildSubscriptionHandshake(
      input({
        request: request({
          auth: { type: 'basic', basic: { username: '{{user}}', password: '{{token}}' } },
        }),
      })
    );
    expect(hs.headers.Authorization).toBe(`Basic ${btoa('alice:tok-123')}`);
  });

  it('inherits folder/collection auth when the request has none', () => {
    const inheritedAuth: AuthConfig = { type: 'bearer', bearer: { token: '{{token}}' } };
    const hs = buildSubscriptionHandshake(input({ inheritedAuth }));
    expect(hs.headers.Authorization).toBe('Bearer tok-123');
  });

  it("keeps the request's own auth over inherited auth", () => {
    const hs = buildSubscriptionHandshake(
      input({
        request: request({ auth: { type: 'bearer', bearer: { token: 'own' } } }),
        inheritedAuth: { type: 'bearer', bearer: { token: 'inherited' } },
      })
    );
    expect(hs.headers.Authorization).toBe('Bearer own');
  });
});

describe('buildSubscriptionHandshake — API key in query (#882)', () => {
  it('appends a query API key to the socket URL, not the headers', () => {
    const hs = buildSubscriptionHandshake(
      input({
        request: request({
          url: 'https://api.example.com/graphql?v=1',
          auth: { type: 'api-key', apiKey: { key: 'api_key', value: '{{token}}', in: 'query' } },
        }),
      })
    );
    expect(hs.url).toBe('https://api.example.com/graphql?v=1&api_key=tok-123');
    expect(Object.keys(hs.headers)).not.toContain('api_key');
  });

  it('falls back to string append for a non-parseable URL', () => {
    const hs = buildSubscriptionHandshake(
      input({
        values: {},
        request: request({
          url: '{{unset}}/graphql#frag',
          headers: [],
          auth: { type: 'api-key', apiKey: { key: 'k y', value: 'v&1', in: 'query' } },
        }),
      })
    );
    expect(hs.url).toBe('{{unset}}/graphql?k%20y=v%261#frag');
  });

  it('keeps a header API key as a header', () => {
    const hs = buildSubscriptionHandshake(
      input({
        request: request({
          auth: { type: 'api-key', apiKey: { key: 'X-Api-Key', value: 'k', in: 'header' } },
        }),
      })
    );
    expect(hs.headers['X-Api-Key']).toBe('k');
  });
});

describe('buildSubscriptionHandshake — SecretRef handles (#882)', () => {
  const handleBearer: AuthConfig = { type: 'bearer', bearer: { token: handle } };

  it('desktop: passes the minimal handle descriptor main-side, no renderer header', () => {
    const hs = buildSubscriptionHandshake(
      input({
        desktop: true,
        request: request({
          auth: {
            type: 'oauth2',
            oauth2: {
              accessToken: handle,
              tokenType: 'Bearer',
              clientSecret: 'inline-client-secret',
            },
          },
        }),
      })
    );
    expect(hs.headers.Authorization).toBeUndefined();
    expect(hs.connectionParams.Authorization).toBeUndefined();
    // Only the fields the wire needs cross IPC — never e.g. the client secret.
    expect(hs.mainSide).toEqual({
      auth: { type: 'oauth2', oauth2: { accessToken: handle, tokenType: 'Bearer' } },
    });
    expect(JSON.stringify(hs)).not.toContain('inline-client-secret');
    expect(hs.unapplied).toEqual([]);
  });

  it.each([
    ['basic', { type: 'basic', basic: { username: 'u', password: handle } }],
    ['api-key', { type: 'api-key', apiKey: { key: 'k', value: handle, in: 'query' } }],
    ['bearer', { type: 'bearer', bearer: { token: handle } }],
  ] as const)('desktop: %s handle goes main-side', (_type, auth) => {
    const hs = buildSubscriptionHandshake(
      input({ desktop: true, request: request({ auth: auth as AuthConfig }) })
    );
    expect(hs.mainSide?.auth).toEqual(auth);
    expect(hs.url).toBe('https://api.example.com/graphql');
  });

  it('handles an auth descriptor missing its block', () => {
    for (const type of ['bearer', 'basic', 'api-key', 'oauth2'] as const) {
      const hs = buildSubscriptionHandshake(input({ request: request({ auth: { type } }) }));
      expect(hs.headers.Authorization).toBeUndefined();
      expect(hs.unapplied).toEqual([]);
    }
  });

  it('web: reports a handle as unapplied and sends nothing for it', () => {
    const hs = buildSubscriptionHandshake(input({ request: request({ auth: handleBearer }) }));
    expect(hs.headers.Authorization).toBeUndefined();
    expect(hs.mainSide).toBeUndefined();
    expect(hs.unapplied).toEqual([expect.stringMatching(/desktop app/)]);
  });
});

describe('buildSubscriptionHandshake — secret variables', () => {
  const secretVariables = { apiSecret: handle };

  it('desktop: shields the token from the renderer and forwards only referenced refs', () => {
    const hs = buildSubscriptionHandshake(
      input({
        desktop: true,
        secretVariables: { ...secretVariables, unused: { kind: 'handle', id: 'h-2' } },
        // A store resolver that would wrongly consume the token if unshielded.
        resolveVariables: (text) => text.replace('{{apiSecret}}', 'LEAKED'),
        request: request({
          headers: [{ id: 'h', key: 'X-Secret', value: '{{apiSecret}}', enabled: true }],
          auth: { type: 'basic', basic: { username: 'u', password: '{{apiSecret}}' } },
        }),
      })
    );
    expect(hs.headers['X-Secret']).toBe('{{apiSecret}}');
    expect(hs.connectionParams['X-Secret']).toBeUndefined();
    expect(hs.headers.Authorization).toBeUndefined();
    expect(hs.mainSide).toEqual({
      auth: { type: 'basic', basic: { username: 'u', password: '{{apiSecret}}' } },
      secretVariables,
    });
    expect(JSON.stringify(hs)).not.toContain('LEAKED');
  });

  it('web: reports referenced secret variables as unapplied', () => {
    const hs = buildSubscriptionHandshake(
      input({
        secretVariables: { a: handle, b: handle },
        request: request({
          url: 'https://api.example.com/{{a}}',
          headers: [{ id: 'h', key: 'X', value: '{{b}}', enabled: true }],
        }),
      })
    );
    expect(hs.mainSide).toBeUndefined();
    expect(hs.unapplied).toEqual([expect.stringContaining('{{a}}, {{b}}')]);
  });
});

describe('buildSubscriptionHandshake — sign-at-wire auth', () => {
  it.each(['digest', 'oauth1', 'aws-signature', 'ntlm', 'wsse'] as const)(
    '%s is reported as unapplied',
    (type) => {
      const hs = buildSubscriptionHandshake(
        input({ desktop: true, request: request({ auth: { type } }) })
      );
      expect(hs.unapplied).toEqual([expect.stringMatching(/isn't applied to subscriptions/)]);
      expect(hs.mainSide).toBeUndefined();
      expect(hs.headers.Authorization).toBeUndefined();
    }
  );
});

describe('prepareSubscriptionHandshake (store-aware)', () => {
  afterEach(() => useCollectionStore.setState({ collections: [] }));

  it('picks up collection-inherited auth from the store', () => {
    const collection = {
      id: 'col-1',
      name: 'C',
      items: [{ id: 'req-1', name: 'sub', type: 'request', request: request() }],
      auth: { type: 'bearer', bearer: { token: 'from-collection' } },
    } as unknown as Collection;
    useCollectionStore.setState({ collections: [collection] });

    const hs = prepareSubscriptionHandshake(
      request({ url: 'https://api.example.com/graphql', headers: [] })
    );
    expect(hs.headers.Authorization).toBe('Bearer from-collection');
    expect(hs.url).toBe('https://api.example.com/graphql');
  });
});
