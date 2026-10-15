import { describe, expect, it } from 'vitest';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '../secrets/collection-redaction';
import type {
  AuthConfig,
  Collection,
  CollectionItem,
  GrpcRequest,
  HttpRequest,
  KeyValue,
  McpRequest,
  Request,
  SseRequest,
} from '../types';
import { internalToOC } from './from-internal';
import { grpcSchemaHash } from './grpc-schema-extension';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
import { ocToInternal } from './to-internal';

/**
 * Generic OpenCollection fidelity harness (#863 #866 #869).
 *
 * Every request type has:
 *  - a FIELD POLICY declared with `satisfies Record<keyof X, FieldPolicy>` —
 *    adding a field to the type without classifying it here fails type-check;
 *  - a FULLY-POPULATED fixture typed `Required<X>` — adding a field without
 *    populating it fails type-check.
 *
 * The harness then runs internal → OC → YAML → OC → internal and deep-equals
 * every `roundtrip` field, with the request placed both at the collection root
 * and inside a nested `Folder/Sub` folder (placement must survive too).
 *
 * `known-gap` is an honest escape hatch for fields the OC serializer does not
 * carry yet — it is listed, so a reviewer sees it, rather than silently lost.
 */

type FieldPolicy = 'roundtrip' | 'regenerated' | 'known-gap';

type WithOC<T> = T & { _oc?: unknown };

const kv = (key: string, value: string, extra: Partial<KeyValue> = {}): KeyValue => ({
  id: `kv-${key}`,
  key,
  value,
  enabled: true,
  ...extra,
});

// ---------------------------------------------------------------------------
// Auth fixtures (exhaustive per block)
// ---------------------------------------------------------------------------

const OAUTH1: Required<NonNullable<AuthConfig['oauth1']>> = {
  consumerKey: 'ck',
  consumerSecret: 'cs',
  accessToken: 'at',
  accessTokenSecret: 'ats',
  signatureMethod: 'HMAC-SHA256',
  realm: 'photos',
  nonce: 'fixed-nonce',
  timestamp: '1700000000',
  addParamsToBody: true,
};

const NTLM: Required<NonNullable<AuthConfig['ntlm']>> = {
  username: 'alice',
  password: 'ntlm-pw',
  domain: 'CORP',
  workstation: 'WS01',
};

const WSSE: Required<NonNullable<AuthConfig['wsse']>> = {
  username: 'bob',
  password: 'wsse-pw',
  passwordType: 'PasswordText',
};

const AUTHS: Record<'oauth1' | 'ntlm' | 'wsse', AuthConfig> = {
  oauth1: { type: 'oauth1', oauth1: OAUTH1 },
  ntlm: { type: 'ntlm', ntlm: NTLM },
  wsse: { type: 'wsse', wsse: WSSE },
};

// ---------------------------------------------------------------------------
// Per-type field policies + fixtures
// ---------------------------------------------------------------------------

const HTTP_FIELDS = {
  id: 'regenerated',
  name: 'roundtrip',
  type: 'roundtrip',
  method: 'roundtrip',
  url: 'roundtrip',
  headers: 'roundtrip',
  params: 'roundtrip',
  body: 'roundtrip',
  auth: 'roundtrip',
  preRequestScript: 'roundtrip',
  testScript: 'roundtrip',
  description: 'roundtrip',
  // Not yet carried by the OC serializer — out of scope for #863/#869.
  settings: 'known-gap',
  contractRef: 'known-gap',
  // Carried by the collection-level x-restura-graphql extension (#867).
  graphqlSchema: 'roundtrip',
  // Carried by the same x-restura-graphql extension entries (#889).
  graphqlSubscriptionProtocol: 'roundtrip',
} as const satisfies Record<keyof HttpRequest, FieldPolicy>;

const HTTP_FIXTURE: Required<HttpRequest> = {
  id: 'http-1',
  name: 'Create user',
  type: 'http',
  method: 'POST',
  url: 'https://api.example.test/users',
  headers: [
    kv('X-Trace', 't-1', { description: 'trace id' }),
    kv('X-Off', 'v', { enabled: false }),
  ],
  params: [kv('page', '2')],
  body: { type: 'json', raw: '{"name":"Ada"}' },
  auth: AUTHS.oauth1,
  preRequestScript: 'rs.variables.set("a", 1);',
  testScript: 'rs.test("ok", () => {});',
  description: 'Creates a user',
  settings: { timeout: 1000, followRedirects: true, maxRedirects: 5, verifySsl: true },
  contractRef: { operationId: 'createUser' },
  graphqlSchema: {
    sdl: 'type Query {\n  user: String\n}',
    source: 'introspection',
    fileName: 'schema.json',
    importedAt: 1700000000000,
  },
  graphqlSubscriptionProtocol: 'subscriptions-transport-ws',
};

const GRPC_FIELDS = {
  id: 'regenerated',
  name: 'roundtrip',
  type: 'roundtrip',
  methodType: 'roundtrip',
  url: 'roundtrip',
  service: 'roundtrip',
  method: 'roundtrip',
  metadata: 'roundtrip',
  message: 'roundtrip',
  auth: 'roundtrip',
  preRequestScript: 'roundtrip',
  testScript: 'roundtrip',
  // Carried by the collection-level x-restura-grpc extension (#871 #921).
  schema: 'roundtrip',
  timeout: 'roundtrip',
  wireProtocol: 'roundtrip',
} as const satisfies Record<keyof GrpcRequest, FieldPolicy>;

const GRPC_FIXTURE: Required<GrpcRequest> = {
  id: 'grpc-1',
  name: 'Say hello',
  type: 'grpc',
  methodType: 'server-streaming',
  url: 'grpc://localhost:50051',
  service: 'greet.v1.GreetService',
  method: 'Greet',
  metadata: [kv('x-tenant', 'acme')],
  message: '{"name":"Ada"}',
  auth: AUTHS.ntlm,
  preRequestScript: 'rs.variables.set("g", 1);',
  testScript: 'rs.test("grpc", () => {});',
  // Provenance (hash + fetchedAt, #937) round-trips with the snapshot.
  schema: {
    kind: 'proto',
    fileName: 'greet.proto',
    text: 'syntax = "proto3";\npackage greet.v1;',
    hash: grpcSchemaHash({
      kind: 'proto',
      fileName: 'greet.proto',
      text: 'syntax = "proto3";\npackage greet.v1;',
    }),
    fetchedAt: 1_760_000_000_000,
  },
  timeout: 5000,
  wireProtocol: 'grpc-web',
};

const SSE_FIELDS = {
  id: 'regenerated',
  name: 'roundtrip',
  type: 'roundtrip',
  url: 'roundtrip',
  headers: 'roundtrip',
  params: 'roundtrip',
  auth: 'roundtrip',
  eventFilter: 'roundtrip',
  reconnectOnResume: 'roundtrip',
  preRequestScript: 'roundtrip',
  testScript: 'roundtrip',
} as const satisfies Record<keyof SseRequest, FieldPolicy>;

const SSE_FIXTURE: Required<SseRequest> = {
  id: 'sse-1',
  name: 'Ticker',
  type: 'sse',
  url: 'https://stream.example.test/events',
  headers: [kv('Accept', 'text/event-stream'), kv('X-Off', 'v', { enabled: false })],
  params: [kv('symbol', 'ACME', { description: 'ticker' })],
  auth: AUTHS.wsse,
  eventFilter: ['price', 'trade'],
  reconnectOnResume: false,
  preRequestScript: 'rs.variables.set("s", 1);',
  testScript: 'rs.test("sse", () => {});',
};

const MCP_FIELDS = {
  id: 'regenerated',
  name: 'roundtrip',
  type: 'roundtrip',
  url: 'roundtrip',
  transport: 'roundtrip',
  headers: 'roundtrip',
  auth: 'roundtrip',
  defaultMethod: 'roundtrip',
  defaultParams: 'roundtrip',
  preRequestScript: 'roundtrip',
  testScript: 'roundtrip',
} as const satisfies Record<keyof McpRequest, FieldPolicy>;

const MCP_FIXTURE: Required<McpRequest> = {
  id: 'mcp-1',
  name: 'Call echo',
  type: 'mcp',
  url: 'https://mcp.example.test/mcp',
  transport: 'http-sse',
  headers: [kv('X-Client', 'restura')],
  auth: AUTHS.oauth1,
  defaultMethod: 'tools/call',
  defaultParams: '{"name":"echo","arguments":{"text":"hi"}}',
  preRequestScript: 'rs.variables.set("m", 1);',
  testScript: 'rs.test("mcp", () => {});',
};

interface Case {
  label: string;
  fixture: Request;
  policy: Record<string, FieldPolicy>;
}

const CASES: Case[] = [
  { label: 'http', fixture: HTTP_FIXTURE, policy: HTTP_FIELDS },
  { label: 'grpc', fixture: GRPC_FIXTURE, policy: GRPC_FIELDS },
  { label: 'sse', fixture: SSE_FIXTURE, policy: SSE_FIELDS },
  { label: 'mcp', fixture: MCP_FIXTURE, policy: MCP_FIELDS },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Deep-strip `id` keys — ids are regenerated on import by design. */
function stripIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'id') continue;
      out[k] = stripIds(v);
    }
    return out;
  }
  return value;
}

function pickRoundtrip(r: Request, policy: Record<string, FieldPolicy>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, p] of Object.entries(policy)) {
    if (p !== 'roundtrip') continue;
    out[field] = (r as unknown as Record<string, unknown>)[field];
  }
  return stripIds(out) as Record<string, unknown>;
}

const reqItem = (r: Request, idSuffix: string): CollectionItem => ({
  id: `item-${r.id}-${idSuffix}`,
  name: r.name,
  type: 'request',
  request: { ...r, id: `${r.id}-${idSuffix}` },
});

/** Export → YAML → parse → import. Mirrors the real export/import + Save-to-Files path. */
function roundTrip(c: WithOC<Collection>): WithOC<Collection> {
  const yaml = serializeOpenCollectionYAML(internalToOC(c));
  return ocToInternal(parseOpenCollectionYAML(yaml));
}

function findFolder(items: CollectionItem[], name: string): CollectionItem {
  const f = items.find((i) => i.type === 'folder' && i.name === name);
  if (!f) throw new Error(`folder ${name} not found in [${items.map((i) => i.name).join(', ')}]`);
  return f;
}

function findRequest(items: CollectionItem[] | undefined, name: string): Request {
  const it = (items ?? []).find((i) => i.type === 'request' && i.name === name);
  if (!it?.request) {
    throw new Error(
      `request ${name} not found in [${(items ?? []).map((i) => i.name).join(', ')}]`
    );
  }
  return it.request;
}

describe('OpenCollection fidelity harness', () => {
  describe.each(CASES)('$label', ({ fixture, policy }) => {
    const collection: Collection = {
      id: 'c',
      name: 'Fidelity',
      items: [
        reqItem(fixture, 'root'),
        {
          id: 'f',
          name: 'Folder',
          type: 'folder',
          items: [
            {
              id: 'sub',
              name: 'Sub',
              type: 'folder',
              items: [reqItem(fixture, 'nested')],
            },
          ],
        },
      ],
    };

    it('every roundtrip field survives export → import at the root', () => {
      const back = roundTrip(collection);
      const r = findRequest(back.items, fixture.name);
      expect(pickRoundtrip(r, policy)).toEqual(pickRoundtrip(fixture, policy));
    });

    it('stays inside Folder/Sub with every roundtrip field intact (#866)', () => {
      const back = roundTrip(collection);
      // Exactly one root copy — the nested one was not hoisted.
      expect(back.items.filter((i) => i.type === 'request')).toHaveLength(1);
      const sub = findFolder(findFolder(back.items, 'Folder').items ?? [], 'Sub');
      const r = findRequest(sub.items, fixture.name);
      expect(pickRoundtrip(r, policy)).toEqual(pickRoundtrip(fixture, policy));
    });

    it('is stable across a second round trip (export of an import)', () => {
      const once = roundTrip(collection);
      const twice = roundTrip(once);
      expect(stripIds(twice.items)).toEqual(stripIds(once.items));
    });
  });
});

describe('OAuth1 / NTLM / WSSE auth round-trip (#869)', () => {
  const bare = (auth: AuthConfig): Request[] => [
    { ...HTTP_FIXTURE, auth },
    { ...GRPC_FIXTURE, auth },
    { ...SSE_FIXTURE, auth },
    { ...MCP_FIXTURE, auth },
  ];

  describe.each(Object.entries(AUTHS))('%s', (_type, auth) => {
    it('round-trips on HTTP, gRPC, SSE and MCP requests', () => {
      const collection: Collection = {
        id: 'c',
        name: 'Auth',
        items: bare(auth).map((r) => reqItem(r, 'a')),
      };
      const back = roundTrip(collection);
      for (const r of bare(auth)) {
        expect(findRequest(back.items, r.name).auth).toEqual(auth);
      }
    });

    it('round-trips at folder and collection level', () => {
      const collection: Collection = {
        id: 'c',
        name: 'Auth',
        auth,
        items: [{ id: 'f', name: 'Secure', type: 'folder', auth, items: [] }],
      };
      const back = roundTrip(collection);
      expect(back.auth).toEqual(auth);
      expect(findFolder(back.items, 'Secure').auth).toEqual(auth);
    });
  });

  it('emits spec field names for the OC auth blocks', () => {
    const oc = internalToOC({
      id: 'c',
      name: 'Auth',
      auth: AUTHS.oauth1,
      items: [],
    });
    expect((oc.request as { auth: unknown }).auth).toMatchObject({
      type: 'oauth1',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      accessToken: 'at',
      accessTokenSecret: 'ats',
      signatureMethod: 'HMAC-SHA256',
      realm: 'photos',
    });
  });

  it('redacts oauth1/ntlm/wsse secrets by default and keeps non-secret fields', () => {
    const collection: Collection = {
      id: 'c',
      name: 'Auth',
      auth: AUTHS.ntlm,
      items: [
        { id: 'f', name: 'F', type: 'folder', auth: AUTHS.wsse, items: [] },
        reqItem({ ...HTTP_FIXTURE, auth: AUTHS.oauth1 }, 'r'),
      ],
    };
    expect(countCollectionInlineSecrets(collection)).toBe(5);
    const yaml = serializeOpenCollectionYAML(internalToOC(redactCollectionSecrets(collection)));
    for (const secret of ['cs', 'at', 'ats', 'ntlm-pw', 'wsse-pw']) {
      expect(yaml).not.toContain(`"${secret}"`);
    }
    const back = ocToInternal(parseOpenCollectionYAML(yaml));
    expect(back.auth?.ntlm).toMatchObject({ username: 'alice', domain: 'CORP', password: '' });
    expect(findFolder(back.items, 'F').auth?.wsse).toMatchObject({ username: 'bob', password: '' });
    expect(findRequest(back.items, HTTP_FIXTURE.name).auth.oauth1).toMatchObject({
      consumerKey: 'ck',
      consumerSecret: '',
      accessTokenSecret: '',
    });
  });

  it('exports SecretRef handles value-less, never as plaintext', () => {
    const auth: AuthConfig = {
      type: 'oauth1',
      oauth1: {
        consumerKey: 'ck',
        consumerSecret: { kind: 'handle', id: 'h-1', label: 'consumer' },
        accessTokenSecret: { kind: 'handle', id: 'h-2' },
      },
    };
    const collection: Collection = {
      id: 'c',
      name: 'Auth',
      items: [reqItem({ ...SSE_FIXTURE, auth }, 'h')],
    };
    expect(countCollectionInlineSecrets(collection)).toBe(0);
    const oc = internalToOC(redactCollectionSecrets(collection));
    const entry = (oc.extensions?.['x-restura-sse'] as Array<{ sse: { auth: unknown } }>)[0];
    expect(entry?.sse.auth).toMatchObject({
      type: 'oauth1',
      consumerSecret: '{{handle:consumer}}',
      accessTokenSecret: '{{handle:h-2}}',
    });
  });

  it('imported OAuth1 secrets are counted once (typed model), not double-counted via _oc', () => {
    const imported = ocToInternal(
      parseOpenCollectionYAML(`opencollection: 1.0.0
info:
  name: Imp
request:
  auth:
    type: oauth1
    consumerKey: ck
    consumerSecret: secret-1
    accessTokenSecret: secret-2
items: []
`)
    );
    expect(imported.auth?.type).toBe('oauth1');
    expect(countCollectionInlineSecrets(imported)).toBe(2);
  });
});

describe('SSE/MCP extension entries — backward compatibility', () => {
  it('imports legacy root-level entries with no folder path at the root', () => {
    const back = ocToInternal(
      parseOpenCollectionYAML(`opencollection: 1.0.0
info:
  name: Legacy
items:
  - info:
      name: Folder
    items: []
extensions:
  x-restura-sse:
    - info:
        type: sse
        name: Old SSE
      sse:
        url: https://old.example.test/sse
  x-restura-mcp:
    - info:
        type: mcp
        name: Old MCP
      mcp:
        url: https://old.example.test/mcp
        transport: streamable-http
`)
    );
    expect(back.items.map((i) => i.name)).toEqual(['Folder', 'Old SSE', 'Old MCP']);
    expect(findRequest(back.items, 'Old SSE')).toMatchObject({ params: [], headers: [] });
  });

  it('falls back to the root when an entry references a folder that does not exist', () => {
    const back = ocToInternal(
      parseOpenCollectionYAML(`opencollection: 1.0.0
info:
  name: Dangling
items: []
extensions:
  x-restura-sse:
    - info:
        type: sse
        name: Orphan
      folderPath: ["Missing"]
      sse:
        url: https://x.example.test/sse
`)
    );
    expect(findRequest(back.items, 'Orphan').type).toBe('sse');
  });

  it('an unchanged import re-exports byte-identically with nested SSE/MCP', () => {
    const collection: Collection = {
      id: 'c',
      name: 'Stable',
      items: [
        {
          id: 'f',
          name: 'Folder',
          type: 'folder',
          items: [reqItem(SSE_FIXTURE, 'n'), reqItem(MCP_FIXTURE, 'n')],
        },
      ],
    };
    const yaml1 = serializeOpenCollectionYAML(internalToOC(collection));
    const imported = ocToInternal(parseOpenCollectionYAML(yaml1));
    const yaml2 = serializeOpenCollectionYAML(internalToOC(imported));
    expect(yaml2).toBe(yaml1);
  });
});

describe('HTTP extension methods round-trip (#857)', () => {
  const withMethod = (method: string): Collection => ({
    id: 'c',
    name: 'Methods',
    items: [reqItem({ ...HTTP_FIXTURE, method }, 'root')],
  });

  it.each(['PROPFIND', 'QUERY', 'PURGE', 'customVerb'])(
    'preserves %s verbatim through export → YAML → import',
    (method) => {
      const r = findRequest(roundTrip(withMethod(method)).items, HTTP_FIXTURE.name);
      expect((r as HttpRequest).method).toBe(method);
    }
  );

  it('normalises a lower-case known method to upper case on import', () => {
    const r = findRequest(roundTrip(withMethod('post')).items, HTTP_FIXTURE.name);
    expect((r as HttpRequest).method).toBe('POST');
  });
});
