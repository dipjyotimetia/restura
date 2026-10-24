/**
 * Byte-identity guard for the GraphQL wire shaping that moved to
 * `shared/graphql/wire.ts`: the snapshot was recorded against the renderer
 * implementation before the move, so the renderer output must not change.
 */
import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import {
  buildGraphQLWireRequest,
  GRAPHQL_ACCEPT,
  GRAPHQL_INCREMENTAL_ACCEPT,
} from '../graphqlHttp';

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'r1',
    name: 'Q',
    type: 'http',
    method: 'POST',
    url: 'https://api.example.com/graphql',
    headers: [{ id: 'h1', key: 'X-Trace', value: 't', enabled: true }],
    params: [
      { id: 'p1', key: 'keep', value: '1', enabled: true },
      { id: 'p2', key: 'query', value: 'stale', enabled: true },
    ],
    body: { type: 'graphql', raw: 'ignored' },
    auth: { type: 'none' },
    settings: { encodeUrlAutomatically: false, timeout: 1000 },
    ...overrides,
  };
}

const envelope = {
  query: 'query Q($id: ID!) { node(id: $id) { id } }',
  variables: { id: '42' },
  operationName: 'Q',
  extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } },
};

describe('buildGraphQLWireRequest — byte-identity snapshot', () => {
  it('constants', () => {
    expect({ GRAPHQL_ACCEPT, GRAPHQL_INCREMENTAL_ACCEPT }).toMatchSnapshot();
  });

  it('POST', () => {
    expect(buildGraphQLWireRequest(req(), envelope)).toMatchSnapshot();
  });

  it('GET', () => {
    expect(buildGraphQLWireRequest(req({ method: 'GET' }), envelope)).toMatchSnapshot();
  });

  it('GET refusal', () => {
    expect(
      buildGraphQLWireRequest(req({ method: 'GET' }), { query: 'mutation { a }' })
    ).toMatchSnapshot();
  });

  it('POST with @defer', () => {
    expect(buildGraphQLWireRequest(req(), { query: '{ a ... @defer { b } }' })).toMatchSnapshot();
  });
});
