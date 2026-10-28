// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { importPostmanCollection } from '../../shared/collections/postman';
import {
  countPostmanBagInlineSecrets,
  redactPostmanBag,
} from '../../shared/collections/postman/redaction';
import {
  redactCommandArgv,
  redactTextCredentials,
  walkCommandLine,
} from '../../shared/collections/postman/text-redaction';
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

describe('handle conversion blanks non-string values under secret keys', () => {
  it('a numeric / object secret is neither kept nor sent to the keychain', async () => {
    const { collection } = importPostmanCollection({
      info: {
        name: 'N',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [],
    });
    (collection as { _postman?: unknown })._postman = {
      auth: {
        type: 'hawk',
        hawk: [
          { key: 'authKey', value: 987654321 },
          { key: 'secret', value: { nested: 'OBJ_SECRET_VALUE' } },
        ],
      },
    };
    const text = JSON.stringify(await convertCollectionSecretsToHandles(collection));
    expect(text).not.toContain('987654321');
    expect(text).not.toContain('OBJ_SECRET_VALUE');
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

describe('Postman v3 (#1200): sidecars use the v2 bag shape, so every guard covers them', () => {
  const v3 = {
    $kind: 'collection',
    name: 'V3',
    items: [
      {
        $kind: 'http-request',
        name: 'Hawk',
        url: 'https://x.example.com',
        auth: { type: 'hawk', credentials: [{ key: 'authKey', value: 'V3_HAWK_KEY' }] },
        examples: [
          {
            $kind: 'http-example',
            name: 'ok',
            request: {
              url: 'https://x.example.com',
              headers: [{ key: 'Authorization', value: 'Bearer V3_ORIG_AUTH' }],
            },
            response: {
              statusCode: 200,
              statusText: 'OK',
              headers: [{ key: 'Set-Cookie', value: 'sid=V3_RESP_COOKIE' }],
              body: { type: 'json', content: '{"token":"V3_RESP_BODY"}' },
            },
          },
        ],
      },
      {
        $kind: 'http-request',
        name: 'OAuth1 RSA',
        url: 'https://x.example.com',
        auth: {
          type: 'oauth1',
          credentials: [
            { key: 'consumerSecret', value: 'V3_MAPPED_CONSUMER_SECRET' },
            { key: 'signatureMethod', value: 'RSA-SHA1' },
            { key: 'privateKey', value: 'V3_RSA_KEY' },
          ],
        },
      },
    ],
  };
  const BAG_ONLY = ['V3_HAWK_KEY', 'V3_ORIG_AUTH', 'V3_RESP_COOKIE', 'V3_RESP_BODY', 'V3_RSA_KEY'];

  it('mapped secrets are not duplicated into _postman', () => {
    const { collection } = importPostmanCollection(v3);
    const bag = JSON.stringify((collection.items[1] as { _postman?: unknown })._postman);
    expect(bag).not.toContain('V3_MAPPED_CONSUMER_SECRET');
    expect(bag).toContain('V3_RSA_KEY');
  });

  it('redaction blanks every v3 sidecar credential', () => {
    const { collection } = importPostmanCollection(v3);
    const text = JSON.stringify(redactCollectionSecrets(collection));
    for (const s of [...BAG_ONLY, 'V3_MAPPED_CONSUMER_SECRET']) expect(text).not.toContain(s);
  });

  it('"store secrets as handles" leaves no v3 plaintext in _postman', async () => {
    const { collection } = importPostmanCollection(v3);
    const converted = await convertCollectionSecretsToHandles(collection);
    const bags = JSON.stringify(converted.items.map((i) => (i as { _postman?: unknown })._postman));
    for (const s of BAG_ONLY) expect(bags).not.toContain(s);
  });

  it('raw v3 bag fields: the export count and the redaction agree', () => {
    // A hand-edited / older bag that was NOT scrubbed at import.
    const bag = {
      item: {
        $kind: 'llm-request',
        headers: [{ key: 'Authorization', value: 'RAW_ITEM_AUTH' }],
        config: { apiKey: 'RAW_ITEM_APIKEY' },
        env: [{ key: 'SAFE', value: '{{ref}}' }],
      },
      settings: { clientSecret: 'RAW_SETTINGS_SECRET', maxHeaderSize: 10 },
      scripts: [{ type: 'grpc:beforeInvoke', code: 'x', password: 'RAW_SCRIPT_PW' }],
      uses: { environment: ['env-1'] },
      schema: { type: 'url', url: 'https://x', token: 'RAW_SCHEMA_TOKEN' },
      authSets: [{ type: 'bearer', credentials: [{ key: 'token', value: 'RAW_AUTHSET_TOKEN' }] }],
    };
    const secrets = [
      'RAW_ITEM_AUTH',
      'RAW_ITEM_APIKEY',
      'RAW_SETTINGS_SECRET',
      'RAW_SCRIPT_PW',
      'RAW_SCHEMA_TOKEN',
      'RAW_AUTHSET_TOKEN',
    ];
    expect(countPostmanBagInlineSecrets(bag)).toBe(secrets.length);
    const redacted = redactPostmanBag(bag);
    const text = JSON.stringify(redacted);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).toContain('{{ref}}');
    expect(countPostmanBagInlineSecrets(redacted)).toBe(0);
  });

  it('a v3 import with secrets in a raw item counts zero (scrubbed at import)', () => {
    // A placeholder kind (LLM): the raw item is kept, scrubbed, in the sidecar.
    const { collection } = importPostmanCollection({
      $kind: 'collection',
      name: 'Raw',
      items: [
        {
          $kind: 'llm-request',
          name: 'LLM',
          url: 'https://x',
          headers: [{ key: 'X-Api-Key', value: 'LLM_KEY' }],
        },
      ],
    });
    expect(JSON.stringify(collection)).not.toContain('LLM_KEY');
    expect(countCollectionInlineSecrets(collection)).toBe(0);
  });

  it('a v3 WebSocket / Socket.IO item is typed (#1209): every secret is counted and redacted on export', () => {
    const { collection } = importPostmanCollection({
      $kind: 'collection',
      name: 'Typed',
      items: [
        {
          $kind: 'websocket-request',
          name: 'WS',
          url: 'wss://user:WS_URLPW@x.example.com/?access_token=WS_QTOKEN&page=2',
          headers: [{ key: 'X-Api-Key', value: 'WS_KEY' }],
          auth: { type: 'bearer', credentials: [{ key: 'token', value: 'WS_BEARER' }] },
        },
        {
          $kind: 'socket.io-request',
          name: 'SIO',
          url: 'https://sio.example.com/?token=SIO_QTOKEN',
          headers: [{ key: 'Authorization', value: 'Bearer SIO_HDR' }],
          queryParams: [{ key: 'api_key', value: 'SIO_KEY' }],
        },
      ],
    });
    const secrets = [
      'WS_URLPW',
      'WS_QTOKEN',
      'WS_KEY',
      'WS_BEARER',
      'SIO_QTOKEN',
      'SIO_HDR',
      'SIO_KEY',
    ];
    // The typed rows / URLs hold what the connection needs; the export prompt sees all of it.
    expect(countCollectionInlineSecrets(collection)).toBe(secrets.length);
    const text = JSON.stringify(redactCollectionSecrets(collection));
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).toContain('page=2');
    expect(countCollectionInlineSecrets(redactCollectionSecrets(collection))).toBe(0);
  });
});

describe('Postman v3 review (#1200): nested / numeric / array / userinfo secrets, bag-only auth', () => {
  const probe = {
    $kind: 'collection',
    name: 'Probe',
    items: [
      {
        // A placeholder kind (raw item kept, scrubbed, in the sidecar). Typed
        // WebSocket items (#1209) are covered above.
        $kind: 'llm-request',
        name: 'WS',
        url: 'wss://user:URLPW@ws.example.com/?access_token=URLQTOKEN',
        auth: { type: 'bearer', credentials: [{ key: 'token', value: 'WS_BEARER' }] },
      },
      {
        $kind: 'http-request',
        name: 'H',
        url: 'https://x.example.com',
        settings: {
          apiKey: { value: 'NESTED' },
          password: 1234,
          token: ['ARR'],
          maxHeaderSize: 10,
        },
      },
      {
        $kind: 'mqtt-request',
        name: 'M',
        url: 'mqtt://broker.example.com',
        auth: {
          type: 'basic',
          credentials: [
            { key: 'username', value: 'u' },
            { key: 'password', value: 'PLAINPW' },
          ],
        },
      },
      {
        $kind: 'kafka-request',
        name: 'K',
        mode: 'producer',
        auth: { type: 'bearer', credentials: [{ key: 'token', value: 'KAFKA_BEARER' }] },
      },
    ],
  };
  const SECRETS = [
    'URLPW',
    'URLQTOKEN',
    'NESTED',
    '1234',
    'ARR',
    'PLAINPW',
    'KAFKA_BEARER',
    'WS_BEARER',
  ];
  const BAG_ONLY_AUTH = ['PLAINPW', 'KAFKA_BEARER', 'WS_BEARER'];

  it('raw values are scrubbed at import (nested, numeric, array, URL userinfo / query)', () => {
    const { collection } = importPostmanCollection(probe);
    const text = JSON.stringify(collection);
    for (const s of ['URLPW', 'URLQTOKEN', 'NESTED', '1234', '"ARR"'])
      expect(text).not.toContain(s);
  });

  it('bag-only auth (broker presets, placeholders) is counted and redacted', () => {
    const { collection } = importPostmanCollection(probe);
    // MQTT basic password, Kafka bearer token and the WS bearer token live
    // only in the bag: the export prompt must see every one of them.
    expect(countCollectionInlineSecrets(collection)).toBe(BAG_ONLY_AUTH.length);
    const text = JSON.stringify(redactCollectionSecrets(collection));
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it('a hand-edited bag: count equals what redaction blanks, for every value type', () => {
    const bag = {
      settings: { apiKey: { value: 'NESTED' }, password: 1234, token: ['ARR'], ok: 1 },
      item: { url: 'https://u:URLPW@h.example.com/?api_key=Q&page=2' },
    };
    // apiKey, password, token subtrees + URL userinfo + api_key query value.
    expect(countPostmanBagInlineSecrets(bag)).toBe(5);
    const redacted = redactPostmanBag(bag);
    const text = JSON.stringify(redacted);
    for (const s of ['NESTED', '1234', 'ARR', 'URLPW', 'api_key=Q']) expect(text).not.toContain(s);
    expect(text).toContain('page=2');
    expect(countPostmanBagInlineSecrets(redacted)).toBe(0);
  });

  it('MCP stdio launch args: secret flag values never reach the bag or the warning', () => {
    const command = [
      'srv --token ARG_TOK1 -p ARG_PW2 --api-key="ARG KEY3" --client-secret=ARG_CS4',
      'DB_PASSWORD=ARG_ENV5 https://u:ARG_URL6@h.example.com/x --header {{authRef}}',
      '--secret {{vaultRef}} --port 8080 -y --verbose',
    ].join(' ');
    const r = importPostmanCollection({
      $kind: 'collection',
      name: 'C',
      items: [{ $kind: 'mcp-request', name: 'S', transport: 'stdio', command }],
    });
    const leaked = ['ARG_TOK1', 'ARG_PW2', 'ARG KEY3', 'ARG_CS4', 'ARG_ENV5', 'ARG_URL6'];
    const text = JSON.stringify(r.collection);
    const warnings = JSON.stringify(r.report.warnings);
    for (const s of leaked) {
      expect(text).not.toContain(s);
      expect(warnings).not.toContain(s);
    }
    const kept = (r.collection.items[0] as { _postman?: { item?: { argv?: string[] } } })._postman
      ?.item?.argv;
    expect(kept).toEqual([
      'srv',
      '--token',
      '',
      '-p',
      '',
      '--api-key=',
      '--client-secret=',
      'DB_PASSWORD=',
      // Fail closed (#1210): every argument value is blanked, secret or not.
      '',
      '--header',
      '{{authRef}}',
      '--secret',
      '{{vaultRef}}',
      '--port',
      '',
      '-y',
      '--verbose',
    ]);
    // A hand-edited bag: count equals what redaction blanks (argv + command).
    const bag = {
      item: { argv: ['srv', '--token', 'T', 'PASSWORD=P', 3], command: 'srv --token T' },
    };
    expect(countPostmanBagInlineSecrets(bag)).toBe(3);
    const redacted = redactPostmanBag(bag);
    expect(redacted).toEqual({
      item: { argv: ['srv', '--token', '', 'PASSWORD=', 3], command: 'srv --token *' },
    });
    expect(countPostmanBagInlineSecrets(redacted)).toBe(0);
  });

  it('"store secrets as handles" leaves no bag-only v3 plaintext', async () => {
    const { collection } = importPostmanCollection(probe);
    const converted = await convertCollectionSecretsToHandles(collection);
    const bags = JSON.stringify(converted.items.map((i) => (i as { _postman?: unknown })._postman));
    for (const s of SECRETS) expect(bags).not.toContain(s);
  });
});

describe('Postman v3 review (#1210): launch argv and free-text URL secrets', () => {
  const v3 = (items: unknown[]) => ({ $kind: 'collection', name: 'C', items });
  const reportText = (r: { report: { warnings: unknown[] } }) => JSON.stringify(r.report.warnings);

  /** count == what redaction blanks, nothing left behind, re-count is 0. */
  function expectScrubbed(bag: Record<string, unknown>, secrets: string[], n: number) {
    expect(countPostmanBagInlineSecrets(bag)).toBe(n);
    const redacted = redactPostmanBag(bag);
    const text = JSON.stringify(redacted);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(countPostmanBagInlineSecrets(redacted)).toBe(0);
  }

  const ARGV_CASES: Array<[string, string[], number]> = [
    ['curl --header "Authorization: Bearer LEAKA1"', ['LEAKA1'], 1],
    ['curl -H "X-Api-Key: LEAKA2"', ['LEAKA2'], 1],
    ['curl "--header=Authorization: Bearer LEAKA3"', ['LEAKA3'], 1],
    ['curl "-HAuthorization: Bearer LEAKA4"', ['LEAKA4'], 1],
    ['srv --endpoint=https://u:LEAKA5@h/x?token=LEAKA6', ['LEAKA5', 'LEAKA6'], 1],
    ['curl -u user:LEAKA7 --user admin:LEAKA8', ['LEAKA7', 'LEAKA8'], 2],
    ['srv --pass LEAKA9 --pat LEAKB1 --github-pat LEAKB2', ['LEAKA9', 'LEAKB1', 'LEAKB2'], 3],
    ['mysql -pLEAKB3 --port 3306', ['LEAKB3', '3306'], 2],
    ['sh -c "node s.js --token LEAKB4"', ['LEAKB4'], 1],
    [`bash -c 'curl -H "X-Api-Key: LEAKB5" https://h'`, ['LEAKB5'], 1],
    ['"--token LEAKB6', ['LEAKB6'], 1],
  ];

  it.each(ARGV_CASES)(
    'stdio command %s: no secret in collection, bag or report',
    (command, secrets, n) => {
      const r = importPostmanCollection(
        v3([{ $kind: 'mcp-request', name: 'S', transport: 'stdio', command }])
      );
      const text = `${JSON.stringify(r.collection)}${reportText(r)}`;
      for (const s of secrets) expect(text).not.toContain(s);
      expectScrubbed({ item: { command } }, secrets, n);
    }
  );

  it('argv form: counts exactly what it blanks; flag names and {{var}} are kept', () => {
    const r = importPostmanCollection(
      v3([
        {
          $kind: 'mcp-request',
          name: 'S',
          transport: 'stdio',
          command: 'srv --port 8080 --token {{t}}',
        },
      ])
    );
    // Fail closed: the port value is blanked too; the flag name and {{var}} stay.
    expect(JSON.stringify(r.collection)).not.toContain('8080');
    expect(JSON.stringify(r.collection)).toContain('"--port"');
    expect(JSON.stringify(r.collection)).toContain('{{t}}');
    const argv = [
      'curl',
      '-H',
      'Authorization: Bearer LEAKC1',
      '-u',
      'me:LEAKC2',
      '--pass',
      'LEAKC3',
    ];
    expectScrubbed({ item: { argv } }, ['LEAKC1', 'LEAKC2', 'LEAKC3'], 3);
  });

  const TEXT_CASES: Array<[string, string, number]> = [
    ['https://h/x?q=a b&api_key=LEAKM1', 'LEAKM1', 1],
    ['https://{{ host }}/x?token=LEAKM2', 'LEAKM2', 1],
    ['https://user:LEAK M3@h/', 'LEAK M3', 1],
    ['https://user:p(LEAKM4)ss@h/ is the server', 'LEAKM4', 1],
    ['https://h/x?token=ab(LEAKM5)ef', 'LEAKM5', 1],
    ["fetch('https://h/x?token=ab(LEAKM6)ef');\nnext();", 'LEAKM6', 1],
    ['const u = base + "/x?api_key=LEAKL1";\nrun(u);', 'LEAKL1', 1],
    ["const t = 'https://bob:LEAKL2@h/p';\nconst v = ok ? a?.b : c;", 'LEAKL2', 1],
  ];

  it.each(TEXT_CASES)('free text / URL value %j: redacted and counted', (value, secret, n) => {
    const r = importPostmanCollection(
      v3([
        {
          $kind: 'http-request',
          name: 'R',
          url: 'https://x.example.com',
          settings: { note: value },
          scripts: [{ type: 'grpc:beforeInvoke', code: value }],
        },
      ])
    );
    const text = `${JSON.stringify(r.collection)}${reportText(r)}`;
    expect(text).not.toContain(secret);
    expectScrubbed({ settings: { note: value } }, [secret], n);
  });

  it('script text keeps ternaries / optional chaining intact', () => {
    const code = 'const v = ok ? a?.b : c;\nconst w = x?.y ?? z;';
    expect(redactPostmanBag({ scripts: [{ code }] })).toEqual({ scripts: [{ code }] });
  });
});

describe('Postman v3 re-audit (#1210): ReDoS, script integrity, depth cap', () => {
  const big = 200_000;
  const LETTERS = 'a'.repeat(big);
  const HEX = '0123456789abcdef'.repeat(big / 16);
  const INPUTS: Array<[string, string]> = [
    ['letters', LETTERS],
    ['hex blob', HEX],
    ['? + letters', `?${LETTERS}`],
    ['{{ + letters', `{{${LETTERS}`],
    ['&k={{ + letters', `&token={{${LETTERS}`],
    ['scheme:// + colons', `a://${':'.repeat(big)}`],
    ['free text of repeated schemes', ` x ${'a://'.repeat(big / 4)}`],
    ['?token= + parens', ` ?token=${'('.repeat(big)}`],
    ['quote-heavy command line', `"a 'b `.repeat(big / 6)],
    ['header-like names', 'Authorization: '.repeat(big / 15)],
    ['escaped double quotes', `"${'\\"'.repeat(big / 2)}`],
    ['URL-context fragments', `/${'?token=a;'.repeat(big / 9)}`],
    ['edge-quote word', `x ${`'"\\`.repeat(big / 3)}y`],
    ['edge-quote words', `'"\\ `.repeat(big / 4)],
    ['flag soup', '--token '.repeat(big / 8)],
    ['URL-context fragment run ending ;', `/${'?a=;'.repeat(big / 4)}`],
    ['URL-context fragment run ending :', `/${'?a=:'.repeat(big / 4)}`],
    ['flag / value pairs (fixpoint rounds)', '--token x '.repeat(big / 10)],
    ['secret header lines', 'Authorization: Bearer x '.repeat(big / 24)],
    ['escaped nested command', `sh -c "${'\\"--token x\\" '.repeat(big / 14)}"`],
  ];
  // Generous bound (linear work is single-digit ms); the quadratic regex took seconds.
  const BOUND_MS = 500;
  const timed = (fn: () => unknown) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it.each(INPUTS)('%s (200 KB) is linear through text, command line and import', (_n, value) => {
    expect(timed(() => redactTextCredentials(value, { n: 0 }))).toBeLessThan(BOUND_MS);
    expect(timed(() => walkCommandLine(value, { n: 0 }))).toBeLessThan(BOUND_MS);
    const v3 = {
      $kind: 'collection',
      name: 'C',
      items: [{ $kind: 'http-request', name: 'R', url: 'https://x', settings: { note: value } }],
    };
    expect(timed(() => importPostmanCollection(v3))).toBeLessThan(BOUND_MS * 2);
  });

  const UNCHANGED = [
    'if (x?.token==="abc") go();',
    'obj?.password=v;\nnext();',
    'var r=e?key=t:n;foo()',
    'const u = `${b}?token=${tok}`;\nsend(u);',
    'call(x?token=t);\nok();',
    'call(x?token=t)',
    'call(x?token=t)\nnext()',
    'f(a?token=b)',
    'g(a?secret=b) || h()',
    'r=e?key=t: n',
    "const remote = 'ssh://deploy@example.com/repo.x';\nrun();",
  ];

  it.each(UNCHANGED)('JS / non-secret text %j comes through unchanged', (code) => {
    expect(redactTextCredentials(code, undefined)).toBe(code);
    const counter = { n: 0 };
    redactTextCredentials(code, counter);
    expect(counter.n).toBe(0);
  });

  it('URL-literal fragments in scripts are still blanked', () => {
    const code = 'const a = base + "/x?api_key=LEAKR1";\nconst b = \'?token=LEAKR2&x=1\';';
    const counter = { n: 0 };
    const out = redactTextCredentials(code, undefined);
    redactTextCredentials(code, counter);
    expect(out).toBe('const a = base + "/x?api_key=";\nconst b = \'?token=&x=1\';');
    expect(counter.n).toBe(2);
  });

  it('free-text userinfo is blanked whole (ssh-like username-only is kept, see UNCHANGED)', () => {
    const code = "const u = 'https://bob:LEAKR3@h/p';\nnext();";
    expect(redactTextCredentials(code, undefined)).toBe("const u = 'https://h/p';\nnext();");
  });

  it('the nesting cap fails closed: a nested command line past the cap is still walked', () => {
    const counter = { n: 0 };
    const out = walkCommandLine('sh -c "node s.js --token LEAKR4"', counter);
    expect(out).not.toContain('LEAKR4');
    expect(counter.n).toBe(1);
  });

  it('a quote-confused nested line gets a quote-ignoring second pass', () => {
    const command = `sh -c "echo Don't; curl -H 'Authorization: Bearer LEAKR5' x"`;
    const r = importPostmanCollection({
      $kind: 'collection',
      name: 'C',
      items: [{ $kind: 'mcp-request', name: 'S', transport: 'stdio', command }],
    });
    const text = `${JSON.stringify(r.collection)}${JSON.stringify(r.report.warnings)}`;
    expect(text).not.toContain('LEAKR5');
    const bag = { item: { command } };
    expect(countPostmanBagInlineSecrets(bag)).toBe(1);
    const redacted = redactPostmanBag(bag);
    expect(JSON.stringify(redacted)).not.toContain('LEAKR5');
    expect(countPostmanBagInlineSecrets(redacted)).toBe(0);
  });
});

describe('Postman v3 final audit (#1210): URL context, userinfo, escapes, both passes, cap', () => {
  const v3 = (items: unknown[]) => ({ $kind: 'collection', name: 'C', items });
  const leakText = (r: { collection: unknown; report: { warnings: unknown[] } }) =>
    `${JSON.stringify(r.collection)}${JSON.stringify(r.report.warnings)}`;

  /** count == what redaction blanks (exact `n` when given), nothing left, re-count 0. */
  function expectScrubbed(bag: Record<string, unknown>, secrets: string[], n?: number) {
    const count = countPostmanBagInlineSecrets(bag);
    if (n === undefined) expect(count).toBeGreaterThan(0);
    else expect(count).toBe(n);
    const redacted = redactPostmanBag(bag);
    const text = JSON.stringify(redacted);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(countPostmanBagInlineSecrets(redacted)).toBe(0);
  }

  const TEXT_LEAKS: Array<[string, string]> = [
    ['[docs](https://api.x.com/v1?api_key=LEAKU1)', 'LEAKU1'],
    ['(see https://h/x?access_token=LEAKU2)', 'LEAKU2'],
    ['$(curl https://h/x?token=LEAKU3)', 'LEAKU3'],
    ['call https://h/x?token=LEAKU4; it returns 200', 'LEAKU4'],
    ['https://h/x?api_key=LEAKU5:extra', 'LEAKU5'],
    ['`https://h/x?token=LEAKU6${suffix}`', 'LEAKU6'],
    ['"https://h/x?client_secret=LEAKU7}"', 'LEAKU7'],
    ['use ?token=LEAKU8; then', 'LEAKU8'],
    ['git clone https://ghp_LEAKU9@github.com/o/r.git', 'ghp_LEAKU9'],
    ['https://sk_live_LEAKV1:@api.stripe.com', 'sk_live_LEAKV1'],
    // A single line that starts with a URL is not only that URL: later URLs
    // in the same line are still free text.
    ['https://docs.example.com/a see https://bob:LEAKV2@h/x', 'LEAKV2'],
    ['https://h/x?q=1 and https://h2/?token=LEAKV3', 'LEAKV3'],
  ];

  it.each(TEXT_LEAKS)('%j: blanked in bag, collection and report; counted', (value, secret) => {
    const r = importPostmanCollection(
      v3([
        {
          $kind: 'http-request',
          name: 'R',
          url: 'https://x.example.com',
          settings: { note: value },
          scripts: [{ type: 'grpc:beforeInvoke', code: value }],
        },
      ])
    );
    expect(leakText(r)).not.toContain(secret);
    expectScrubbed({ settings: { note: value } }, [secret], 1);
    expect(redactTextCredentials(value, undefined)).not.toContain(secret);
  });

  const COMMAND_LEAKS: Array<[string, string[], number | undefined]> = [
    ['sh -c "curl -H \\"Authorization: Bearer LEAKE1\\" u"', ['LEAKE1'], 1],
    ['sh -c "sh -c \\"API_KEY=LEAKE2 node s\\""', ['LEAKE2'], 1],
    [
      `sh -c "echo Don't --token LEAKF1; curl -H 'Authorization: Bearer LEAKF2' x"`,
      ['LEAKF1', 'LEAKF2'],
      // Not exact: the shell-style re-parse of the quote-confused line also
      // blanks one non-secret word (over-redaction); count == blanked holds.
      undefined,
    ],
  ];

  it.each(COMMAND_LEAKS)('stdio %s: every secret blanked; counted', (command, secrets, n) => {
    const r = importPostmanCollection(
      v3([{ $kind: 'mcp-request', name: 'S', transport: 'stdio', command }])
    );
    const text = leakText(r);
    for (const s of secrets) expect(text).not.toContain(s);
    expectScrubbed({ item: { command } }, secrets, n);
  });

  it('past the cap a flat pass still blanks a nested --token', () => {
    const counter = { n: 0 };
    const out = walkCommandLine('sh -c "node s --token LEAKG1"', counter);
    expect(out).not.toContain('LEAKG1');
    expect(counter.n).toBe(1);
  });

  const nest = (cmd: string, levels: number) => {
    let s = cmd;
    for (let i = 0; i < levels; i += 1) s = `sh -c '${s.replaceAll("'", `'"'"'`)}'`;
    return s;
  };
  const DEEP: Array<[string, string]> = [
    ['node s --token LEAKH1', 'LEAKH1'],
    ['node s --token=LEAKH2', 'LEAKH2'],
    ["curl -H 'Authorization: Bearer LEAKH3' u", 'LEAKH3'],
    ['API_KEY=LEAKH4 node s', 'LEAKH4'],
  ];

  it.each(DEEP)('%s nested 5 and 6 levels deep is blanked', (inner, secret) => {
    for (const levels of [5, 6]) {
      const command = nest(inner, levels);
      const r = importPostmanCollection(
        v3([{ $kind: 'mcp-request', name: 'S', transport: 'stdio', command }])
      );
      expect(leakText(r)).not.toContain(secret);
      expectScrubbed({ item: { command } }, [secret]);
    }
  });
});

describe('Postman v3 simplification audit (#1210): bounded output, userinfo, URL values', () => {
  const wrap = (cmd: string, levels: number) => {
    let s = cmd;
    for (let i = 0; i < levels; i += 1) s = `sh -c '${s.replaceAll("'", `'"'"'`)}'`;
    return s;
  };

  it.each([200_000, 1_000_000])(
    'a nested-quote flood (%d bytes) never grows and stays fast',
    (size) => {
      // 3 wrap levels turn each `'` into 125 characters; size the input to `size`.
      const flood = wrap(`--token LEAKS1 "${"'".repeat(Math.floor(size / 125))}"`, 3);
      expect(flood.length).toBeLessThanOrEqual(size + 200);
      const t0 = performance.now();
      const counter = { n: 0 };
      walkCommandLine(flood, counter);
      const out = walkCommandLine(flood, undefined);
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(out.length).toBeLessThanOrEqual(flood.length);
      expect(out).not.toContain('LEAKS1');
      expect(counter.n).toBeGreaterThan(0);
      const bag = { item: { command: flood, argv: [flood] } };
      const redacted = redactPostmanBag(bag) as { item: { command: string; argv: string[] } };
      expect(redacted.item.command.length).toBeLessThanOrEqual(flood.length);
      expect(String(redacted.item.argv[0]).length).toBeLessThanOrEqual(flood.length);
      expect(countPostmanBagInlineSecrets(redacted)).toBe(0);
    }
  );

  it('userinfo with an @ in the password is blanked to the last @, idempotently', () => {
    const code = "const u = 'https://admin:P@ssw0rd@h/x';\nnext();";
    const once = redactTextCredentials(code, undefined);
    expect(once).toBe("const u = 'https://h/x';\nnext();");
    const counter = { n: 0 };
    redactTextCredentials(once, counter);
    expect(counter.n).toBe(0);
  });

  it.each([
    ['const a = "https://h/x?auth=user:LEAKS2&y=1";\nrun(a);', 'LEAKS2', 'y=1'],
    ['const b = "https://h/x?token=123456:LEAKS3";\nrun(b);', 'LEAKS3', 'run(b)'],
    ['const c = `https://h/x?token=ab$LEAKS4${x}`;\nrun(c);', 'LEAKS4', '${x}'],
  ])('URL-context value %j runs to & # quote whitespace or ${', (code, secret, kept) => {
    const out = redactTextCredentials(code, undefined);
    expect(out).not.toContain(secret);
    expect(out).toContain(kept);
    expectRecountZero({ settings: { note: code } });
  });

  it('deterministic fuzz: redaction is idempotent (re-count 0) and never lengthens', () => {
    const PARTS = [
      '--token',
      ' ',
      'X',
      '-H',
      "'",
      '"',
      '\\',
      'Authorization:',
      'Bearer',
      'https://',
      'a:b@',
      '@',
      'h/x',
      '?token=',
      '&api_key=',
      'v',
      ';',
      ':',
      ')',
      '(',
      '${',
      '}',
      '=',
      'KEY=',
      'API_KEY=',
      '-p',
      'pw',
      '-u',
      'u:p',
      '\n',
      'sh -c ',
      '{{x}}',
      '/',
      '?.',
      '==',
      '#',
      'ssh://',
    ];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const failures: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      let s = '';
      const len = 1 + Math.floor(rnd() * 14);
      for (let j = 0; j < len; j += 1) s += PARTS[Math.floor(rnd() * PARTS.length)];
      for (const bag of [
        { item: { command: s } },
        { settings: { note: s } },
        { item: { argv: [s] } },
      ]) {
        if (countPostmanBagInlineSecrets(redactPostmanBag(bag)) !== 0) {
          failures.push(JSON.stringify(bag));
        }
      }
      if (walkCommandLine(s, undefined).length > s.length) failures.push(`grows: ${s}`);
      if (redactTextCredentials(s, undefined).length > s.length) failures.push(`grows: ${s}`);
    }
    expect(failures).toEqual([]);
  });

  function expectRecountZero(bag: Record<string, unknown>) {
    expect(countPostmanBagInlineSecrets(bag)).toBe(1);
    expect(countPostmanBagInlineSecrets(redactPostmanBag(bag))).toBe(0);
  }
});

describe('Postman v3 fail-closed launch commands (#1210): argument values are not imported', () => {
  const v3 = (items: unknown[]) => ({ $kind: 'collection', name: 'C', items });

  function expectBlanked(bag: Record<string, unknown>, secrets: string[]) {
    expect(countPostmanBagInlineSecrets(bag)).toBeGreaterThan(0);
    const redacted = redactPostmanBag(bag);
    const text = JSON.stringify(redacted);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(countPostmanBagInlineSecrets(redacted)).toBe(0);
  }

  const COMMANDS: Array<[string, string[]]> = [
    ['tool --password "LEAKQ1 TAILQ1"', ['LEAKQ1', 'TAILQ1']],
    ["tool --password='LEAKQ2 TAILQ2'", ['LEAKQ2', 'TAILQ2']],
    ['tool "--password=LEAKQ3 TAILQ3"', ['LEAKQ3', 'TAILQ3']],
    ['curl -u "bob:LEAKQ4 TAILQ4" h', ['LEAKQ4', 'TAILQ4']],
    ['DB_PASSWORD="LEAKQ5 TAILQ5" node s', ['LEAKQ5', 'TAILQ5']],
    [`sh -c "tool --password 'LEAKQ6 TAILQ6'"`, ['LEAKQ6', 'TAILQ6']],
    ['curl example.com?token=LEAKQ8; ok', ['LEAKQ8']],
    ['$(curl example.com?token=LEAKQ9)', ['LEAKQ9']],
    ['sh -c "curl -s vault.local:8200?token=LEAKQA; run"', ['LEAKQA']],
  ];

  it.each(COMMANDS)(
    'stdio %s: values blanked in collection, report and bag',
    (command, secrets) => {
      const r = importPostmanCollection(
        v3([{ $kind: 'mcp-request', name: 'S', transport: 'stdio', command }])
      );
      const text = `${JSON.stringify(r.collection)}${JSON.stringify(r.report.warnings)}`;
      for (const s of secrets) expect(text).not.toContain(s);
      expectBlanked({ item: { command } }, secrets);
      const out = walkCommandLine(command, undefined);
      expect(out.length).toBeLessThanOrEqual(command.length);
    }
  );

  it('argv: the nested payload of bash -lc is blanked', () => {
    const argv = ['bash', '-lc', 'run --password "LEAKQ7 TAILQ7"'];
    expectBlanked({ item: { argv } }, ['LEAKQ7', 'TAILQ7']);
    expect(JSON.stringify(redactCommandArgv(argv))).not.toMatch(/LEAKQ7|TAILQ7/);
  });

  it('keeps the executable, flag names and {{var}} words; blanks everything else', () => {
    const out = walkCommandLine('npx -y "server everything" --port=8080 {{tok}} KEY=v', undefined);
    expect(out).toBe("npx -y '' --port= {{tok}} KEY=");
    expect(redactCommandArgv(['npx', '-y', 'server', '--port=8080', '{{tok}}'])).toEqual([
      'npx',
      '-y',
      '',
      '--port=',
      '{{tok}}',
    ]);
  });

  // The executable slot is the FIRST non-KEY=V word: if it does not qualify
  // it is blanked / treated as an option, never handed to the next word.
  const EXEC_SLOT: Array<[string, unknown[], string]> = [
    [
      '"C:\\Program Files\\node.exe" sk_live_LEAKX1',
      ['C:\\Program Files\\node.exe', 'sk_live_LEAKX1'],
      'LEAKX1',
    ],
    ["'npx' LEAKX2", ["'npx'", 'LEAKX2'], 'LEAKX2'],
    ['"/path with space/tool" LEAKX3', ['/path with space/tool', 'LEAKX3'], 'LEAKX3'],
    ['--token LEAKX4', ['--token', 'LEAKX4'], 'LEAKX4'],
    ['- LEAKX5', ['-', 'LEAKX5'], 'LEAKX5'],
    ['-- LEAKX6', ['--', 'LEAKX6'], 'LEAKX6'],
    ['"" LEAKX7', ['', 'LEAKX7'], 'LEAKX7'],
    ['--=a\\ LEAKX8', ['--=a\\', 'LEAKX8'], 'LEAKX8'],
  ];

  it.each(EXEC_SLOT)(
    'exec slot %s: no next-word promotion (command and argv)',
    (command, argv, secret) => {
      expect(walkCommandLine(command, undefined)).not.toContain(secret);
      expect(JSON.stringify(redactCommandArgv(argv as string[]))).not.toContain(secret);
      expectBlanked({ item: { command } }, [secret]);
      expectBlanked({ item: { argv } }, [secret]);
      const r = importPostmanCollection(
        v3([{ $kind: 'mcp-request', name: 'S', transport: 'stdio', command }])
      );
      expect(`${JSON.stringify(r.collection)}${JSON.stringify(r.report.warnings)}`).not.toContain(
        secret
      );
    }
  );

  it('argv redaction is idempotent when the first element is blanked', () => {
    const bag = { item: { argv: ['--$x', 'h'] } };
    const redacted = redactPostmanBag(bag);
    expect(countPostmanBagInlineSecrets(bag)).toBe(2);
    expect(redacted).toEqual({ item: { argv: ['', ''] } });
    expect(countPostmanBagInlineSecrets(redacted)).toBe(0);
  });
});
