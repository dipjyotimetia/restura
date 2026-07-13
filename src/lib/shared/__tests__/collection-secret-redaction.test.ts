import { describe, it, expect } from 'vitest';
import {
  redactAuthConfigSecrets,
  redactCollectionSecrets,
  countCollectionInlineSecrets,
} from '../collection-secret-redaction';
import { exportToOpenCollection } from '@/features/collections/lib/exporters';
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

  it('sanitises auth-bearing OpenCollection _oc bags and keeps auth-free ones', () => {
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
          // Folder bag carries a child with plaintext auth → must blank it.
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
    expect(JSON.stringify((out.items[0] as { _oc?: unknown })._oc)).not.toContain('LEAK');
    expect(JSON.stringify((out.items[0]!.items![0] as { _oc?: unknown })._oc)).not.toContain(
      'LEAK'
    );
    expect((out.items[1] as { _oc?: unknown })._oc).toEqual(wsBag);
  });

  it('keeps a safe collection-level _oc bag for round-trip fidelity', () => {
    const withRootBag = {
      ...collection,
      _oc: { opencollection: '1.0.0', info: { name: 'C' }, items: [] },
    } as unknown as Collection;
    const out = redactCollectionSecrets(withRootBag);
    expect((out as { _oc?: unknown })._oc).toEqual((withRootBag as { _oc?: unknown })._oc);
  });

  it('redacts AWS session tokens retained only in an OpenCollection bag', () => {
    const withRootBag = {
      ...collection,
      _oc: {
        request: {
          auth: {
            type: 'awsv4',
            accessKeyId: 'PUBLIC-ID',
            secretAccessKey: 'AWS-SECRET',
            sessionToken: 'AWS-SESSION',
          },
        },
      },
    } as unknown as Collection;
    const out = redactCollectionSecrets(withRootBag) as Collection & { _oc?: unknown };
    expect(JSON.stringify(out._oc)).not.toContain('AWS-SECRET');
    expect(JSON.stringify(out._oc)).not.toContain('AWS-SESSION');
    expect(JSON.stringify(out._oc)).toContain('PUBLIC-ID');
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

  it('redacts root-level auth of types that degrade to none on import (oauth1)', async () => {
    // The leak the bearer-based test above cannot catch: OAuth1/NTLM/WSSE
    // degrade to { type: 'none' } in authToInternal, so collection.auth ends
    // up undefined and the exporter's authUnchanged gate sees none === none —
    // "unchanged" — and (pre-fix) emitted the cached root _oc verbatim,
    // original consumerSecret included. All items keep auth-free bags here so
    // the whole-collection shortcut (Strategy 1) is otherwise viable.
    const { parseOpenCollectionYAML, serializeOpenCollectionYAML } =
      await import('@/lib/opencollection/serializer');
    const { ocToInternal } = await import('@/lib/opencollection/to-internal');
    const { internalToOC } = await import('@/lib/opencollection/from-internal');

    const yaml = `opencollection: 1.0.0
info:
  name: Degraded Root Auth
request:
  auth:
    type: oauth1
    consumerKey: ck-public
    consumerSecret: OAUTH1-CONSUMER-SECRET
    accessTokenSecret: OAUTH1-TOKEN-SECRET
items:
  - info:
      type: graphql
      name: Gql Query
    graphql:
      url: https://api.example.com/graphql
      query: "query { viewer { login } }"
`;
    const internal = ocToInternal(parseOpenCollectionYAML(yaml));
    const redacted = redactCollectionSecrets(internal);
    const exported = internalToOC(redacted);
    const out = serializeOpenCollectionYAML(exported);
    expect(out).not.toContain('OAUTH1-CONSUMER-SECRET');
    expect(out).not.toContain('OAUTH1-TOKEN-SECRET');
    // Still a structurally valid document with its items intact.
    expect(exported.items?.length).toBe(1);
    expect(out).toMatch(/type: "?graphql"?/);
    expect(out).toContain('query { viewer { login } }');
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

  // OpenCollection degrade-to-none auth (OAuth1/NTLM/WSSE) leaves plaintext ONLY
  // in the `_oc` passthrough bag, with the typed auth degraded to `type:'none'`.
  // The count must see it so the export dialog fires (otherwise raw export leaks).
  it('counts plaintext in an item _oc bag with degraded (OAuth1) auth', () => {
    const item = requestItem('r', { type: 'none' }) as CollectionItem & { _oc?: unknown };
    item._oc = {
      name: 'R',
      request: {
        auth: { type: 'oauth1', consumerKey: 'ck', consumerSecret: 'plaintext-secret' },
      },
    };
    const c: Collection = { id: 'c', name: 'C', items: [item] };
    expect(countCollectionInlineSecrets(c)).toBeGreaterThan(0);
  });

  it('counts a cert passphrase in the root _oc bag (real OC schema shape)', () => {
    const c = {
      id: 'c',
      name: 'C',
      items: [requestItem('r', { type: 'none' })],
      _oc: {
        info: { name: 'C' },
        config: {
          clientCertificates: [{ privateKeyFilePath: '/k.pem', passphrase: 'cert-pass' }],
        },
      },
    } as Collection;
    expect(countCollectionInlineSecrets(c)).toBeGreaterThan(0);
  });

  it('counts a proxy password at its real nested path config.proxy.config.auth.password', () => {
    const c = {
      id: 'c',
      name: 'C',
      items: [requestItem('r', { type: 'none' })],
      _oc: {
        info: { name: 'C' },
        config: {
          proxy: { config: { hostname: 'p', auth: { username: 'u', password: 'proxy-pass' } } },
        },
      },
    } as Collection;
    expect(countCollectionInlineSecrets(c)).toBeGreaterThan(0);
  });

  it('counts an OAuth1 inline RSA privateKey (object-valued) in an item _oc bag', () => {
    const item = requestItem('r', { type: 'none' }) as CollectionItem & { _oc?: unknown };
    item._oc = {
      name: 'R',
      request: {
        auth: {
          type: 'oauth1',
          signatureMethod: 'RSA-SHA256',
          consumerKey: 'ck',
          // the only secret is the inline PEM private key
          privateKey: { type: 'text', value: '-----BEGIN RSA PRIVATE KEY-----abc' },
        },
      },
    };
    const c: Collection = { id: 'c', name: 'C', items: [item] };
    expect(countCollectionInlineSecrets(c)).toBeGreaterThan(0);
  });

  it('does NOT count an OAuth1 file-path privateKey (a path, not a secret)', () => {
    const item = requestItem('r', { type: 'none' }) as CollectionItem & { _oc?: unknown };
    item._oc = {
      name: 'R',
      request: {
        auth: {
          type: 'oauth1',
          signatureMethod: 'RSA-SHA256',
          consumerKey: 'ck',
          privateKey: { type: 'file', value: '/path/to/key.pem' },
        },
      },
    };
    const c: Collection = { id: 'c', name: 'C', items: [item] };
    expect(countCollectionInlineSecrets(c)).toBe(0);
  });

  it('does NOT over-count a supported-type _oc bag (already counted via typed fields)', () => {
    // A bearer auth survives as a typed field AND in _oc. The typed counter sees
    // it once; the _oc walker must not add a second phantom count, and an
    // auth-free / supported-only bag must not trip the dialog on its own.
    const item = requestItem('r', { type: 'none' }) as CollectionItem & { _oc?: unknown };
    item._oc = { name: 'R', request: { auth: { type: 'bearer', token: 'tok' } } };
    const c: Collection = { id: 'c', name: 'C', items: [item] };
    expect(countCollectionInlineSecrets(c)).toBe(0);
  });
});

describe('header / query-param secret redaction (H6)', () => {
  const collectionWithFieldSecrets = (): Collection => ({
    id: 'c',
    name: 'C',
    items: [
      {
        id: 'r',
        name: 'R',
        type: 'request',
        request: {
          id: 'r-req',
          name: 'R',
          type: 'http',
          method: 'GET',
          url: 'https://api.example.com',
          headers: [
            { id: 'h1', key: 'Authorization', value: 'Bearer sk-secret', enabled: true },
            { id: 'h2', key: 'Accept', value: 'application/json', enabled: true },
          ],
          params: [
            { id: 'p1', key: 'api_key', value: 'k-123', enabled: true },
            { id: 'p2', key: 'page', value: '1', enabled: true },
          ],
          body: { type: 'none' },
          auth: { type: 'none' },
        },
      },
    ],
  });

  it('blanks secret-named headers and query params but keeps innocuous rows', () => {
    const req = redactCollectionSecrets(collectionWithFieldSecrets()).items[0]!
      .request as HttpRequest;
    expect(req.headers.find((h) => h.key === 'Authorization')!.value).toBe('');
    expect(req.headers.find((h) => h.key === 'Accept')!.value).toBe('application/json');
    expect(req.params.find((p) => p.key === 'api_key')!.value).toBe('');
    expect(req.params.find((p) => p.key === 'page')!.value).toBe('1');
  });

  it('counts header/param secrets in the export-warning total (was 0 before the fix)', () => {
    expect(countCollectionInlineSecrets(collectionWithFieldSecrets())).toBe(2);
  });

  it('honors an explicit secret flag on an innocuously-named row', () => {
    const c = collectionWithFieldSecrets();
    (c.items[0]!.request as HttpRequest).headers.push({
      id: 'h3',
      key: 'X-Custom',
      value: 'topsecret',
      enabled: true,
      secret: true,
    });
    const req = redactCollectionSecrets(c).items[0]!.request as HttpRequest;
    expect(req.headers.find((h) => h.key === 'X-Custom')!.value).toBe('');
  });
});

// The end-to-end security property: redaction must keep plaintext out of the
// actual exported YAML bytes, not merely out of the typed model. Guards against
// a future redactor/exporter change silently reopening the `_oc` passthrough leak.
describe('OpenCollection export — no plaintext _oc secret leak (security regression)', () => {
  const OAUTH1_SECRET = 'PLAINTEXT-OAUTH1-CONSUMER-SECRET';
  const CERT_PASS = 'PLAINTEXT-CERT-PASSPHRASE';
  const PROXY_PASS = 'PLAINTEXT-PROXY-PASSWORD';

  /** A collection as if imported from OpenCollection: degrade-to-none OAuth1 auth
   *  on an item (plaintext only in the item `_oc`) plus root proxy/cert secrets
   *  (only in the root `_oc`). The typed model carries none of these. */
  function ocImportedCollectionWithBagSecrets(): Collection {
    const itemOc = {
      name: 'R',
      request: {
        method: 'GET',
        url: 'https://api.example.com',
        auth: { type: 'oauth1', consumerKey: 'ck', consumerSecret: OAUTH1_SECRET },
      },
    };
    const item: CollectionItem & { _oc?: unknown } = {
      id: 'r',
      name: 'R',
      type: 'request',
      request: request('r-req', { type: 'none' }),
      _oc: itemOc,
    };
    const c = {
      id: 'c',
      name: 'C',
      items: [item],
      _oc: {
        opencollection: '1.0.0',
        info: { name: 'C' },
        config: {
          clientCertificates: [{ privateKeyFilePath: '/k.pem', passphrase: CERT_PASS }],
          proxy: { config: { hostname: 'p', auth: { username: 'u', password: PROXY_PASS } } },
        },
        items: [itemOc],
      },
    } as Collection;
    return c;
  }

  it('a non-redacted export DOES leak the bag secrets (proves the fixture is a real leak path)', () => {
    const raw = exportToOpenCollection(ocImportedCollectionWithBagSecrets());
    // At least one of the bag-only secrets reaches the bytes on a raw export.
    expect(raw).toContain(PROXY_PASS);
  });

  it('a redacted export contains NONE of the bag secrets', () => {
    const yaml = exportToOpenCollection(
      redactCollectionSecrets(ocImportedCollectionWithBagSecrets())
    );
    expect(yaml).not.toContain(OAUTH1_SECRET);
    expect(yaml).not.toContain(CERT_PASS);
    expect(yaml).not.toContain(PROXY_PASS);
  });

  it('preserves unknown OpenCollection extensions while redacting bag-only secrets', () => {
    const collection = ocImportedCollectionWithBagSecrets();
    const root = (collection as Collection & { _oc: Record<string, unknown> })._oc;
    root.extensions = { 'x-team-metadata': { owner: 'platform' } };

    const yaml = exportToOpenCollection(redactCollectionSecrets(collection));

    expect(yaml).toContain('x-team-metadata');
    expect(yaml).toContain('platform');
    expect(yaml).not.toContain(PROXY_PASS);
  });

  it('countCollectionInlineSecrets fires the export dialog for this collection (gate)', () => {
    expect(countCollectionInlineSecrets(ocImportedCollectionWithBagSecrets())).toBeGreaterThan(0);
  });
});
