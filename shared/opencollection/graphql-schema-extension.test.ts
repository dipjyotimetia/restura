import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem, GraphQLImportedSchema, HttpRequest } from '../types';
import { internalToOC } from './from-internal';
import { GRAPHQL_EXTENSION_KEY } from './graphql-schema-extension';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
import { ocToInternal } from './to-internal';

const SCHEMA_A: GraphQLImportedSchema = {
  sdl: 'type Query {\n  ping: String\n}',
  source: 'sdl',
  fileName: 'schema.graphqls',
  importedAt: 1700000000000,
};
const SCHEMA_B: GraphQLImportedSchema = {
  sdl: 'type Query {\n  user: String\n}',
  source: 'introspection',
  importedAt: 1700000000001,
};

function gql(name: string, graphqlSchema?: GraphQLImportedSchema): HttpRequest {
  return {
    id: `id-${name}`,
    name,
    type: 'http',
    method: 'POST',
    url: 'https://api.example/graphql',
    headers: [],
    params: [],
    body: { type: 'graphql', raw: '{ ping }' },
    auth: { type: 'none' },
    ...(graphqlSchema ? { graphqlSchema } : {}),
  };
}

const item = (r: HttpRequest): CollectionItem => ({
  id: `item-${r.name}`,
  type: 'request',
  name: r.name,
  request: r,
});

function fixture(): Collection {
  return {
    id: 'c',
    name: 'GraphQL schemas',
    items: [
      item(gql('A1', SCHEMA_A)),
      item(gql('A2', SCHEMA_A)),
      { id: 'f', type: 'folder', name: 'Folder', items: [item(gql('B', SCHEMA_B))] },
      item(gql('None')),
    ],
  };
}

function gqlRequests(items: CollectionItem[] | undefined): HttpRequest[] {
  const out: HttpRequest[] = [];
  for (const it of items ?? []) {
    if (it.type === 'folder') out.push(...gqlRequests(it.items));
    else if (it.request?.type === 'http') out.push(it.request);
  }
  return out;
}

describe('OpenCollection imported GraphQL schema extension', () => {
  it('dedupes identical schemas into one collection-level entry', () => {
    const oc = internalToOC(fixture());
    const ext = (oc.extensions as Record<string, unknown>)[GRAPHQL_EXTENSION_KEY] as {
      schemas: Record<string, unknown>;
      requests: Array<{ path: string[]; schema: string }>;
    };
    expect(Object.keys(ext.schemas)).toHaveLength(2);
    expect(ext.requests.map((r) => r.path)).toEqual([['A1'], ['A2'], ['Folder', 'B']]);
    expect(ext.requests[0]?.schema).toBe(ext.requests[1]?.schema);
  });

  it('dedupes the same SDL imported at different times / from different files', () => {
    const later: GraphQLImportedSchema = {
      sdl: SCHEMA_A.sdl,
      source: 'introspection',
      importedAt: SCHEMA_A.importedAt + 60_000,
    };
    const collection: Collection = {
      id: 'c',
      name: 'Same SDL',
      items: [item(gql('First', SCHEMA_A)), item(gql('Second', later))],
    };
    const ext = (internalToOC(collection).extensions as Record<string, unknown>)[
      GRAPHQL_EXTENSION_KEY
    ] as { schemas: Record<string, unknown>; requests: Array<{ schema: string }> };

    expect(Object.keys(ext.schemas)).toHaveLength(1);
    expect(ext.requests[0]?.schema).toBe(ext.requests[1]?.schema);

    // Provenance stays per request.
    const yaml = serializeOpenCollectionYAML(internalToOC(collection));
    const back = gqlRequests(ocToInternal(parseOpenCollectionYAML(yaml)).items);
    expect(back.map((r) => r.graphqlSchema)).toEqual([SCHEMA_A, later]);
  });

  it('omits the extension when no request has an imported schema', () => {
    const oc = internalToOC({ id: 'c', name: 'Plain', items: [item(gql('None'))] });
    expect(oc.extensions?.[GRAPHQL_EXTENSION_KEY]).toBeUndefined();
  });

  it('round-trips imported schemas through YAML', () => {
    const yaml = serializeOpenCollectionYAML(internalToOC(fixture()));
    const back = ocToInternal(parseOpenCollectionYAML(yaml));
    expect(gqlRequests(back.items).map((r) => [r.name, r.graphqlSchema])).toEqual([
      ['A1', SCHEMA_A],
      ['A2', SCHEMA_A],
      ['B', SCHEMA_B],
      ['None', undefined],
    ]);
  });

  it('ignores malformed extension entries on import', () => {
    const oc = internalToOC({ id: 'c', name: 'X', items: [item(gql('A1'))] });
    (oc as { extensions?: Record<string, unknown> }).extensions = {
      [GRAPHQL_EXTENSION_KEY]: {
        schemas: { h: { sdl: 5 } },
        requests: [{ path: ['A1'], schema: 'h' }, { path: 'bad' }],
      },
    };
    const back = ocToInternal(oc);
    expect(gqlRequests(back.items)[0]?.graphqlSchema).toBeUndefined();
  });
  function importWithExtension(ext: unknown, items = [item(gql('A1'))]): HttpRequest[] {
    const oc = internalToOC({ id: 'c', name: 'X', items });
    (oc as { extensions?: Record<string, unknown> }).extensions = { [GRAPHQL_EXTENSION_KEY]: ext };
    return gqlRequests(ocToInternal(oc).items);
  }

  const entry = (path: string[], schema: string) => ({
    path,
    schema,
    source: 'sdl',
    importedAt: 1,
  });

  it('ignores a well-formed entry whose schema hash is missing from the table', () => {
    const back = importWithExtension({
      schemas: { known: { sdl: SCHEMA_A.sdl } },
      requests: [entry(['A1'], 'unknown')],
    });
    expect(back[0]?.graphqlSchema).toBeUndefined();
  });

  it.each([
    ['a non-object extension', 'x-restura-graphql: yes'],
    ['a schemas table that is not an object', { schemas: 'nope', requests: [entry(['A1'], 'h')] }],
    [
      'a requests list that is not an array',
      { schemas: { h: { sdl: SCHEMA_A.sdl } }, requests: {} },
    ],
  ])('ignores %s', (_label, ext) => {
    expect(importWithExtension(ext)[0]?.graphqlSchema).toBeUndefined();
  });

  it('attaches the schema to the GraphQL request, not a REST request with the same name path', () => {
    const rest: HttpRequest = { ...gql('Same'), id: 'rest', body: { type: 'json', raw: '{}' } };
    const collection: Collection = {
      id: 'c',
      name: 'Mixed',
      items: [
        { id: 'item-rest', type: 'request', name: 'Same', request: rest },
        item(gql('Same', SCHEMA_A)),
      ],
    };
    const yaml = serializeOpenCollectionYAML(internalToOC(collection));
    const back = ocToInternal(parseOpenCollectionYAML(yaml));
    const [first, second] = gqlRequests(back.items);
    expect(first?.body?.type).toBe('json');
    expect(first?.graphqlSchema).toBeUndefined();
    expect(second?.graphqlSchema?.sdl).toBe(SCHEMA_A.sdl);
  });

  it('ignores an entry whose index points past the same-path requests', () => {
    const oc = internalToOC({ id: 'c', name: 'One', items: [item(gql('Only'))] });
    const hash = 'h';
    oc.extensions = {
      ...oc.extensions,
      [GRAPHQL_EXTENSION_KEY]: {
        schemas: { [hash]: { sdl: SCHEMA_A.sdl } },
        requests: [{ path: ['Only'], index: 3, schema: hash, source: 'sdl', importedAt: 1 }],
      },
    };
    const [only] = gqlRequests(ocToInternal(oc).items);
    expect(only?.graphqlSchema).toBeUndefined();
  });

  it('matches duplicate request names positionally and leaves unmatched entries unused', () => {
    const back = importWithExtension(
      {
        schemas: { a: { sdl: SCHEMA_A.sdl }, b: { sdl: SCHEMA_B.sdl } },
        requests: [entry(['Dup'], 'a'), entry(['Dup'], 'b'), entry(['Gone'], 'a')],
      },
      [item(gql('Dup')), { ...item(gql('Dup')), id: 'item-Dup-2' }]
    );
    expect(back.map((r) => r.graphqlSchema?.sdl)).toEqual([SCHEMA_A.sdl, SCHEMA_B.sdl]);
  });

  describe('subscription protocol (#889)', () => {
    it('round-trips a protocol-only request (no schema) through YAML', () => {
      const req: HttpRequest = { ...gql('Sub'), graphqlSubscriptionProtocol: 'graphql-sse' };
      const collection: Collection = {
        id: 'c',
        name: 'Subs',
        items: [item(gql('Plain')), item(req)],
      };
      const oc = internalToOC(collection);
      const ext = (oc.extensions as Record<string, unknown>)[GRAPHQL_EXTENSION_KEY] as {
        schemas: Record<string, unknown>;
        requests: Array<Record<string, unknown>>;
      };
      expect(ext.schemas).toEqual({});
      expect(ext.requests).toEqual([{ path: ['Sub'], subscriptionProtocol: 'graphql-sse' }]);

      const back = gqlRequests(
        ocToInternal(parseOpenCollectionYAML(serializeOpenCollectionYAML(oc))).items
      );
      expect(back.map((r) => [r.name, r.graphqlSubscriptionProtocol, r.graphqlSchema])).toEqual([
        ['Plain', undefined, undefined],
        ['Sub', 'graphql-sse', undefined],
      ]);
    });

    it('carries schema and protocol on one entry', () => {
      const req: HttpRequest = {
        ...gql('Both', SCHEMA_A),
        graphqlSubscriptionProtocol: 'subscriptions-transport-ws',
      };
      const back = gqlRequests(
        ocToInternal(
          parseOpenCollectionYAML(
            serializeOpenCollectionYAML(internalToOC({ id: 'c', name: 'X', items: [item(req)] }))
          )
        ).items
      );
      expect(back[0]?.graphqlSchema).toEqual(SCHEMA_A);
      expect(back[0]?.graphqlSubscriptionProtocol).toBe('subscriptions-transport-ws');
    });

    it('degrades an unknown protocol to absent but still applies the schema', () => {
      const back = importWithExtension({
        schemas: { h: { sdl: SCHEMA_A.sdl } },
        requests: [{ ...entry(['A1'], 'h'), subscriptionProtocol: 'graphql-mqtt' }],
      });
      expect(back[0]?.graphqlSubscriptionProtocol).toBeUndefined();
      expect(back[0]?.graphqlSchema?.sdl).toBe(SCHEMA_A.sdl);
    });

    it('ignores a schema reference that lacks provenance', () => {
      const back = importWithExtension({
        schemas: { h: { sdl: SCHEMA_A.sdl } },
        requests: [{ path: ['A1'], schema: 'h', subscriptionProtocol: 'auto' }],
      });
      expect(back[0]?.graphqlSchema).toBeUndefined();
      expect(back[0]?.graphqlSubscriptionProtocol).toBe('auto');
    });
  });

  describe('selected operation (#903)', () => {
    const withOp = (name: string, op: string, schema?: GraphQLImportedSchema): HttpRequest => {
      const r = gql(name, schema);
      return {
        ...r,
        body: { type: 'graphql', raw: 'query A { a } query B { b }', graphqlOperationName: op },
      };
    };

    it('round-trips the selected operation with and without an imported schema', () => {
      const collection: Collection = {
        id: 'c',
        name: 'Ops',
        items: [
          item(withOp('Plain', 'B')),
          { id: 'f', type: 'folder', name: 'F', items: [item(withOp('Typed', 'A', SCHEMA_A))] },
          item(gql('None')),
        ],
      };
      const ext = (internalToOC(collection).extensions as Record<string, unknown>)[
        GRAPHQL_EXTENSION_KEY
      ] as { requests: Array<Record<string, unknown>> };
      expect(ext.requests).toEqual([
        { path: ['Plain'], operationName: 'B' },
        expect.objectContaining({ path: ['F', 'Typed'], operationName: 'A', source: 'sdl' }),
      ]);

      const yaml = serializeOpenCollectionYAML(internalToOC(collection));
      const back = gqlRequests(ocToInternal(parseOpenCollectionYAML(yaml)).items);
      expect(back.map((r) => [r.name, r.body.graphqlOperationName, r.graphqlSchema])).toEqual([
        ['Plain', 'B', undefined],
        ['Typed', 'A', SCHEMA_A],
        ['None', undefined, undefined],
      ]);
    });

    it('carries schema, subscription protocol and operation on one entry in any combination', () => {
      const all: HttpRequest = {
        ...withOp('All', 'B', SCHEMA_A),
        graphqlSubscriptionProtocol: 'graphql-sse',
      };
      const protoAndOp: HttpRequest = {
        ...withOp('ProtoOp', 'A'),
        graphqlSubscriptionProtocol: 'subscriptions-transport-ws',
      };
      const collection: Collection = {
        id: 'c',
        name: 'Combos',
        items: [item(all), item(protoAndOp)],
      };
      const ext = (internalToOC(collection).extensions as Record<string, unknown>)[
        GRAPHQL_EXTENSION_KEY
      ] as { requests: Array<Record<string, unknown>> };
      expect(ext.requests).toEqual([
        expect.objectContaining({
          path: ['All'],
          source: 'sdl',
          subscriptionProtocol: 'graphql-sse',
          operationName: 'B',
        }),
        {
          path: ['ProtoOp'],
          subscriptionProtocol: 'subscriptions-transport-ws',
          operationName: 'A',
        },
      ]);

      const yaml = serializeOpenCollectionYAML(internalToOC(collection));
      const back = gqlRequests(ocToInternal(parseOpenCollectionYAML(yaml)).items);
      expect(
        back.map((r) => [
          r.name,
          r.body.graphqlOperationName,
          r.graphqlSubscriptionProtocol,
          r.graphqlSchema,
        ])
      ).toEqual([
        ['All', 'B', 'graphql-sse', SCHEMA_A],
        ['ProtoOp', 'A', 'subscriptions-transport-ws', undefined],
      ]);
    });

    it('degrades a malformed operation name to absent but applies the rest', () => {
      const [a1] = importWithExtension({
        schemas: { h: { sdl: SCHEMA_A.sdl } },
        requests: [{ ...entry(['A1'], 'h'), operationName: 42, subscriptionProtocol: 'auto' }],
      });
      expect(a1?.body.graphqlOperationName).toBeUndefined();
      expect(a1?.graphqlSchema?.sdl).toBe(SCHEMA_A.sdl);
      expect(a1?.graphqlSubscriptionProtocol).toBe('auto');
    });

    it('applies the operation even when the schema half of the entry is unusable', () => {
      const [a1] = importWithExtension({
        schemas: {},
        requests: [{ path: ['A1'], schema: 'missing', operationName: 'Op' }],
      });
      expect(a1?.body.graphqlOperationName).toBe('Op');
      expect(a1?.graphqlSchema).toBeUndefined();
    });

    it('never puts an operation on a non-GraphQL body', () => {
      const rest: HttpRequest = { ...gql('R'), body: { type: 'json', raw: '{}' } };
      const [r] = importWithExtension(
        { schemas: {}, requests: [{ path: ['R'], operationName: 'Op' }] },
        [item(rest)]
      );
      expect(r?.body).toEqual({ type: 'json', raw: '{}' });
    });

    it('ignores an entry that carries neither a schema nor an operation', () => {
      const [a1] = importWithExtension({ schemas: {}, requests: [{ path: ['A1'] }] });
      expect(a1?.body.graphqlOperationName).toBeUndefined();
      expect(a1?.graphqlSchema).toBeUndefined();
    });
  });
});
