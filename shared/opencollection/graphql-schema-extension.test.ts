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

  it('omits the extension when no request has an imported schema', () => {
    const oc = internalToOC({ id: 'c', name: 'Plain', items: [item(gql('None'))] });
    expect((oc.extensions ?? {})[GRAPHQL_EXTENSION_KEY]).toBeUndefined();
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
});
