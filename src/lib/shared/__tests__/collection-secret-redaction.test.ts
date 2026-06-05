import { describe, it, expect } from 'vitest';
import {
  redactAuthConfigSecrets,
  redactCollectionSecrets,
  countCollectionInlineSecrets,
} from '../collection-secret-redaction';
import type { AuthConfig, Collection, CollectionItem, HttpRequest } from '@/types';

const request = (id: string, auth: AuthConfig): HttpRequest => ({
  id,
  name: 'R',
  type: 'http',
  method: 'GET',
  url: 'https://example.com',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth,
});

const requestItem = (id: string, auth: AuthConfig): CollectionItem => ({
  id,
  name: 'R',
  type: 'request',
  request: request(`${id}-req`, auth),
});

describe('redactAuthConfigSecrets', () => {
  it('blanks plain-string secrets but keeps non-secret fields', () => {
    const out = redactAuthConfigSecrets({
      type: 'basic',
      basic: { username: 'alice', password: 'hunter2' },
    });
    expect(out.basic).toEqual({ username: 'alice', password: '' });
  });

  it('blanks inline SecretRef values', () => {
    const out = redactAuthConfigSecrets({
      type: 'bearer',
      bearer: { token: { kind: 'inline', value: 'tok-123' } },
    });
    expect(out.bearer?.token).toEqual({ kind: 'inline', value: '' });
  });

  it('preserves handle references untouched', () => {
    const handle = { kind: 'handle' as const, id: 'h-1', label: 'prod token' };
    const out = redactAuthConfigSecrets({ type: 'bearer', bearer: { token: handle } });
    expect(out.bearer?.token).toEqual(handle);
  });

  it('redacts every oauth2 secret field but keeps flow config', () => {
    const out = redactAuthConfigSecrets({
      type: 'oauth2',
      oauth2: {
        accessToken: 'at',
        refreshToken: 'rt',
        clientSecret: 'cs',
        password: 'pw',
        clientId: 'my-client',
        tokenUrl: 'https://idp/token',
      },
    });
    expect(out.oauth2).toEqual({
      accessToken: '',
      refreshToken: '',
      clientSecret: '',
      password: '',
      clientId: 'my-client',
      tokenUrl: 'https://idp/token',
    });
  });

  it('does not mutate the input', () => {
    const auth: AuthConfig = { type: 'basic', basic: { username: 'a', password: 'secret' } };
    redactAuthConfigSecrets(auth);
    expect(auth.basic?.password).toBe('secret');
  });
});

describe('redactCollectionSecrets', () => {
  const collection: Collection = {
    id: 'c1',
    name: 'C',
    auth: { type: 'bearer', bearer: { token: 'collection-token' } },
    items: [
      {
        id: 'f1',
        name: 'F',
        type: 'folder',
        auth: {
          type: 'aws-signature',
          awsSignature: { accessKey: 'AK', secretKey: 'SK', region: 'r', service: 's' },
        },
        items: [requestItem('r1', { type: 'basic', basic: { username: 'u', password: 'p' } })],
      },
      requestItem('r2', { type: 'api-key', apiKey: { key: 'X-Key', value: 'v', in: 'header' } }),
    ],
  };

  it('redacts collection, folder, and request auth across the tree', () => {
    const out = redactCollectionSecrets(collection);
    expect(out.auth?.bearer?.token).toBe('');
    const folder = out.items[0]!;
    expect(folder.auth?.awsSignature).toEqual({
      accessKey: 'AK',
      secretKey: '',
      region: 'r',
      service: 's',
    });
    expect(folder.items![0]!.request!.auth.basic?.password).toBe('');
    expect(out.items[1]!.request!.auth.apiKey?.value).toBe('');
  });

  it('does not mutate the original tree', () => {
    redactCollectionSecrets(collection);
    expect(collection.auth?.bearer?.token).toBe('collection-token');
    expect(collection.items[0]!.items![0]!.request!.auth.basic?.password).toBe('p');
  });

  it('drops auth-bearing OpenCollection _oc bags but keeps auth-free ones', () => {
    // The _oc bag holds the verbatim imported node — including the
    // pre-redaction plaintext auth — and the OC exporter emits per-item bags
    // verbatim, so a surviving auth-bearing bag would leak the original
    // secrets through a "redacted" export. Auth-free bags must survive:
    // GraphQL/WebSocket items round-trip only through them.
    const wsBag = { info: { type: 'websocket', name: 'WS' }, websocket: { url: 'wss://x' } };
    const withBags = {
      ...collection,
      items: [
        {
          ...collection.items[0]!,
          // Folder bag carries a child with plaintext auth → must drop.
          _oc: { items: [{ http: { auth: { type: 'bearer', token: 'LEAK' } } }] },
          items: [
            { ...collection.items[0]!.items![0]!, _oc: { http: { auth: { token: 'LEAK' } } } },
          ],
        },
        // Auth-free WebSocket placeholder bag → must be kept.
        { id: 'ws1', name: 'WS (WebSocket)', type: 'folder', items: [], _oc: wsBag },
      ],
    } as unknown as Collection;
    const out = redactCollectionSecrets(withBags);
    expect((out.items[0] as { _oc?: unknown })._oc).toBeUndefined();
    expect((out.items[0]!.items![0] as { _oc?: unknown })._oc).toBeUndefined();
    expect((out.items[1] as { _oc?: unknown })._oc).toEqual(wsBag);
  });
});

describe('redacted OpenCollection export (end-to-end regression)', () => {
  it('a redacted export of an imported OC document contains no plaintext secrets', async () => {
    // Reproduces the leak this guards against: import stamps the verbatim OC
    // node (with plaintext auth) into _oc; without the bag-drop in
    // redactCollectionSecrets, internalToOC emits it verbatim and the
    // "redacted" YAML ships the original token.
    const { parseOpenCollectionYAML, serializeOpenCollectionYAML } =
      await import('@/lib/opencollection/serializer');
    const { ocToInternal } = await import('@/lib/opencollection/to-internal');
    const { internalToOC } = await import('@/lib/opencollection/from-internal');

    const yaml = `opencollection: 1.0.0
info:
  name: Leak Demo
request:
  auth:
    type: bearer
    token: ROOT-SECRET
items:
  - info:
      name: Folder
    request:
      auth:
        type: basic
        username: alice
        password: FOLDER-SECRET
    items:
      - info:
          type: http
          name: Secret Req
        http:
          method: GET
          url: https://api.example.com/x
          auth:
            type: bearer
            token: REQUEST-SECRET
  - info:
      type: graphql
      name: Gql Query
    graphql:
      url: https://api.example.com/graphql
      query: "query { viewer { login } }"
  - info:
      type: websocket
      name: Live Feed
    websocket:
      url: wss://api.example.com/feed
`;
    const internal = ocToInternal(parseOpenCollectionYAML(yaml));
    const redacted = redactCollectionSecrets(internal);
    const out = serializeOpenCollectionYAML(internalToOC(redacted));
    expect(out).not.toContain('ROOT-SECRET');
    expect(out).not.toContain('FOLDER-SECRET');
    expect(out).not.toContain('REQUEST-SECRET');
    // Non-secret auth shape survives redaction.
    expect(out).toContain('alice');
    // Auth-free GraphQL/WebSocket items survive through their kept _oc bags —
    // these shapes are unrecoverable from the internal model alone (GraphQL
    // degrades to plain HTTP, WebSocket placeholders vanish).
    expect(out).toMatch(/type: "?graphql"?/);
    expect(out).toContain('query { viewer { login } }');
    expect(out).toMatch(/type: "?websocket"?/);
    expect(out).toContain('wss://api.example.com/feed');
  });
});

describe('countCollectionInlineSecrets', () => {
  it('counts plain-string and inline secrets, ignoring handles and empties', () => {
    const c: Collection = {
      id: 'c1',
      name: 'C',
      auth: { type: 'bearer', bearer: { token: 'tok' } }, // 1
      items: [
        requestItem('r1', {
          type: 'oauth2',
          oauth2: {
            accessToken: { kind: 'inline', value: 'at' }, // 2
            clientSecret: { kind: 'handle', id: 'h-1' }, // handle — not counted
          },
        }),
        requestItem('r2', { type: 'basic', basic: { username: 'u', password: '' } }), // empty — not counted
      ],
    };
    expect(countCollectionInlineSecrets(c)).toBe(2);
  });

  it('returns 0 for a collection with no auth anywhere', () => {
    const c: Collection = { id: 'c', name: 'C', items: [requestItem('r', { type: 'none' })] };
    expect(countCollectionInlineSecrets(c)).toBe(0);
  });
});
