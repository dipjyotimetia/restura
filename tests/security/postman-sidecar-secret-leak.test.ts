// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { importPostmanCollection } from '../../shared/collections/postman';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '../../shared/secrets/collection-redaction';
import { convertCollectionSecretsToHandles } from '../../src/lib/shared/secretRef-migrations';

let handleSeq = 0;
const store = vi.fn(async (_: { value: string; label: string }) => ({
  ok: true as const,
  id: `h-${++handleSeq}`,
}));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => true,
  getElectronAPI: () => ({ secrets: { store } }),
}));

describe('approximated typed auth keeps only unmapped keys in the sidecar (ADR-0007)', () => {
  const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
  const withAuth = (auth: unknown) => ({
    info: { name: 'A', schema: V21 },
    item: [{ name: 'R', request: { method: 'GET', url: 'https://x.example.com', auth } }],
  });

  it('oauth1 RSA: mapped secrets are NOT duplicated into _postman', () => {
    const { collection } = importPostmanCollection(
      withAuth({
        type: 'oauth1',
        oauth1: [
          { key: 'consumerKey', value: 'ck' },
          { key: 'consumerSecret', value: 'MAPPED_CONSUMER_SECRET' },
          { key: 'token', value: 'MAPPED_TOKEN' },
          { key: 'tokenSecret', value: 'MAPPED_TOKEN_SECRET' },
          { key: 'signatureMethod', value: 'RSA-SHA1' },
          { key: 'privateKey', value: 'RSA_PRIVATE_KEY' },
        ],
      })
    );
    const bag = JSON.stringify((collection.items[0] as { _postman?: unknown })._postman);
    for (const s of ['MAPPED_CONSUMER_SECRET', 'MAPPED_TOKEN', 'MAPPED_TOKEN_SECRET', '"ck"']) {
      expect(bag).not.toContain(s);
    }
    expect(bag).toContain('RSA-SHA1');
    expect(bag).toContain('RSA_PRIVATE_KEY');
  });

  it('oauth2 PKCE: mapped secrets are NOT duplicated into _postman', () => {
    const { collection } = importPostmanCollection(
      withAuth({
        type: 'oauth2',
        oauth2: [
          { key: 'grant_type', value: 'authorization_code_with_pkce' },
          { key: 'clientSecret', value: 'MAPPED_CLIENT_SECRET' },
          { key: 'accessToken', value: 'MAPPED_ACCESS' },
          { key: 'password', value: 'MAPPED_PASSWORD' },
          { key: 'refreshToken', value: 'BAG_ONLY_REFRESH' },
        ],
      })
    );
    const bag = JSON.stringify((collection.items[0] as { _postman?: unknown })._postman);
    for (const s of ['MAPPED_CLIENT_SECRET', 'MAPPED_ACCESS', 'MAPPED_PASSWORD']) {
      expect(bag).not.toContain(s);
    }
    expect(bag).toContain('authorization_code_with_pkce');
    expect(bag).toContain('BAG_ONLY_REFRESH');
  });

  it('a bag-only oauth1 privateKey is counted as an inline secret', () => {
    const { collection } = importPostmanCollection(
      withAuth({
        type: 'oauth1',
        oauth1: [
          { key: 'signatureMethod', value: 'RSA-SHA1' },
          { key: 'privateKey', value: 'RSA_PRIVATE_KEY' },
        ],
      })
    );
    expect(countCollectionInlineSecrets(collection)).toBeGreaterThanOrEqual(1);
  });
});

describe('"store secrets as handles" import leaves no plaintext in _postman', () => {
  it('converts bag-only auth credentials to handles and blanks the rest', async () => {
    const { collection } = importPostmanCollection({
      info: {
        name: 'H',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      auth: { type: 'jwt', jwt: [{ key: 'secret', value: 'ROOT_JWT_SECRET' }] },
      item: [
        {
          name: 'F',
          auth: { type: 'edgegrid', edgegrid: [{ key: 'clientSecret', value: 'EG_SECRET' }] },
          item: [
            {
              name: 'R',
              variable: [{ key: 'apiToken', value: 'VAR_SECRET' }],
              request: {
                method: 'GET',
                url: 'https://x.example.com',
                auth: {
                  type: 'oauth1',
                  oauth1: [
                    { key: 'consumerSecret', value: 'TYPED_CONSUMER_SECRET' },
                    { key: 'signatureMethod', value: 'RSA-SHA1' },
                    { key: 'privateKey', value: 'RSA_PRIVATE_KEY' },
                  ],
                },
              },
              response: [
                {
                  name: 'ok',
                  header: [{ key: 'Set-Cookie', value: 'sid=RESP_COOKIE' }],
                  body: '{"token":"RESP_BODY_TOKEN"}',
                },
              ],
            },
          ],
        },
      ],
    });
    const converted = await convertCollectionSecretsToHandles(collection);
    const text = JSON.stringify(converted);
    for (const s of [
      'ROOT_JWT_SECRET',
      'EG_SECRET',
      'VAR_SECRET',
      'TYPED_CONSUMER_SECRET',
      'RSA_PRIVATE_KEY',
      'RESP_COOKIE',
      'RESP_BODY_TOKEN',
    ]) {
      expect(text).not.toContain(s);
    }
    const stored = store.mock.calls.map(([arg]) => arg.value);
    expect(stored).toEqual(
      expect.arrayContaining(['ROOT_JWT_SECRET', 'EG_SECRET', 'RSA_PRIVATE_KEY'])
    );
    expect(countCollectionInlineSecrets(converted)).toBe(0);
  });
});

describe('hostile sibling auth blocks never survive in plaintext', () => {
  const hostileAuth = {
    type: 'hawk',
    hawk: [{ key: 'authKey', value: 'HAWK_SIBLING_KEY' }],
    // Not the active type: Postman ignores it, but it is still credential material.
    bearer: [{ key: 'token', value: 'SIBLING_BEARER' }],
    edgegrid: { clientSecret: 'SIBLING_EDGEGRID' },
  };
  const collectionWith = () =>
    importPostmanCollection({
      info: {
        name: 'S',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        { name: 'R', request: { method: 'GET', url: 'https://x.example.com', auth: hostileAuth } },
      ],
    }).collection;

  it('import keeps only the active type block in the sidecar', () => {
    const bag = (collectionWith().items[0] as { _postman?: { auth?: unknown } })._postman;
    expect(bag?.auth).toEqual({ type: 'hawk', hawk: hostileAuth.hawk });
  });

  it('handle conversion of a pre-existing hostile bag leaves no sibling plaintext', async () => {
    const collection = collectionWith();
    // Simulate a bag persisted before import-time trimming (or crafted on disk).
    (collection.items[0] as { _postman?: unknown })._postman = { auth: hostileAuth };
    const text = JSON.stringify(await convertCollectionSecretsToHandles(collection));
    for (const s of ['HAWK_SIBLING_KEY', 'SIBLING_BEARER', 'SIBLING_EDGEGRID']) {
      expect(text).not.toContain(s);
    }
  });
});

describe('nesting depth is bounded', () => {
  function deepChain(depth: number): unknown {
    let node: Record<string, unknown> = {
      name: 'leaf',
      request: {
        method: 'GET',
        url: 'https://x.example.com',
        auth: { type: 'hawk', hawk: [{ key: 'authKey', value: 'DEEP_SECRET' }] },
      },
    };
    for (let i = 0; i < depth; i++) node = { name: `f${i}`, item: [node] };
    return {
      info: {
        name: 'Deep',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [node],
    };
  }

  it('import rejects a 1000-deep chain with a clear error', () => {
    expect(() => importPostmanCollection(deepChain(1000))).toThrow(/nest/i);
  });

  it('redaction of a 1000-deep collection does not throw or leak', () => {
    type Node = { id: string; name: string; type: 'folder' | 'request'; items?: Node[] } & Record<
      string,
      unknown
    >;
    let node: Node = {
      id: 'leaf',
      name: 'leaf',
      type: 'request',
      _postman: { auth: { type: 'hawk', hawk: [{ key: 'authKey', value: 'DEEP_SECRET' }] } },
    };
    for (let i = 0; i < 1000; i++)
      node = { id: `f${i}`, name: `f${i}`, type: 'folder', items: [node] };
    const collection = { id: 'c', name: 'Deep', items: [node] } as never;
    expect(JSON.stringify(redactCollectionSecrets(collection))).not.toContain('DEEP_SECRET');
    expect(() => countCollectionInlineSecrets(collection)).not.toThrow();
  });
});

/**
 * ADR 0034 / #1199: the `_postman` sidecar keeps raw Postman JSON for
 * unmodelled constructs, which can include credentials. A redacted export
 * must not carry any of them, and the export-warning counter must see them.
 */
describe('Postman _postman sidecar never leaks plaintext through redaction', () => {
  const SECRETS = ['HAWK_KEY_123', 'JWT_SECRET_456', 'RESP_TOKEN_789', 'ORIG_AUTH_000'];

  const postman = {
    info: {
      name: 'Leak',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'jwt', jwt: [{ key: 'secret', value: 'JWT_SECRET_456' }] },
    item: [
      {
        name: 'R',
        request: {
          method: 'GET',
          url: 'https://api.example.com',
          auth: { type: 'hawk', hawk: [{ key: 'authKey', value: 'HAWK_KEY_123' }] },
        },
        response: [
          {
            name: 'ok',
            header: [{ key: 'Set-Cookie', value: 'sid=RESP_TOKEN_789' }],
            body: '{"token":"RESP_TOKEN_789"}',
            originalRequest: {
              header: [{ key: 'Authorization', value: 'Bearer ORIG_AUTH_000' }],
            },
          },
        ],
      },
    ],
  };

  it('imported sidecars hold the raw material (precondition)', () => {
    const { collection } = importPostmanCollection(postman);
    const text = JSON.stringify(collection);
    for (const s of SECRETS) expect(text).toContain(s);
  });

  it('redactCollectionSecrets blanks every sidecar credential', () => {
    const { collection } = importPostmanCollection(postman);
    const text = JSON.stringify(redactCollectionSecrets(collection));
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it('countCollectionInlineSecrets sees sidecar-only credentials', () => {
    const { collection } = importPostmanCollection(postman);
    // jwt secret + hawk authKey + Set-Cookie row + response body + originalRequest Authorization row
    expect(countCollectionInlineSecrets(collection)).toBe(5);
  });

  it('the import report never echoes sidecar contents', () => {
    const { report } = importPostmanCollection(postman);
    const text = JSON.stringify(report);
    for (const s of SECRETS) expect(text).not.toContain(s);
  });
});
