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
    expect({ GRAPHQL_ACCEPT, GRAPHQL_INCREMENTAL_ACCEPT }).toMatchInlineSnapshot(`
      {
        "GRAPHQL_ACCEPT": "application/graphql-response+json, application/json;q=0.9",
        "GRAPHQL_INCREMENTAL_ACCEPT": "multipart/mixed;deferSpec=20220824, application/graphql-response+json;q=0.9, application/json;q=0.8",
      }
    `);
  });

  it('POST', () => {
    expect(buildGraphQLWireRequest(req(), envelope)).toMatchInlineSnapshot(`
      {
        "method": "POST",
        "ok": true,
        "request": {
          "auth": {
            "type": "none",
          },
          "body": {
            "raw": "{"query":"query Q($id: ID!) { node(id: $id) { id } }","variables":{"id":"42"},"operationName":"Q","extensions":{"persistedQuery":{"version":1,"sha256Hash":"abc"}}}",
            "type": "json",
          },
          "headers": [
            {
              "enabled": true,
              "id": "h1",
              "key": "X-Trace",
              "value": "t",
            },
            {
              "enabled": true,
              "id": "graphql-accept",
              "key": "Accept",
              "value": "application/graphql-response+json, application/json;q=0.9",
            },
            {
              "enabled": true,
              "id": "graphql-content-type",
              "key": "Content-Type",
              "value": "application/json",
            },
          ],
          "id": "r1",
          "method": "POST",
          "name": "Q",
          "params": [
            {
              "enabled": true,
              "id": "p1",
              "key": "keep",
              "value": "1",
            },
            {
              "enabled": true,
              "id": "p2",
              "key": "query",
              "value": "stale",
            },
          ],
          "settings": {
            "encodeUrlAutomatically": false,
            "timeout": 1000,
          },
          "type": "http",
          "url": "https://api.example.com/graphql",
        },
      }
    `);
  });

  it('GET', () => {
    expect(buildGraphQLWireRequest(req({ method: 'GET' }), envelope)).toMatchInlineSnapshot(`
      {
        "method": "GET",
        "ok": true,
        "request": {
          "auth": {
            "type": "none",
          },
          "body": {
            "type": "none",
          },
          "headers": [
            {
              "enabled": true,
              "id": "h1",
              "key": "X-Trace",
              "value": "t",
            },
            {
              "enabled": true,
              "id": "graphql-accept",
              "key": "Accept",
              "value": "application/graphql-response+json, application/json;q=0.9",
            },
          ],
          "id": "r1",
          "method": "GET",
          "name": "Q",
          "params": [
            {
              "enabled": true,
              "id": "p1",
              "key": "keep",
              "value": "1",
            },
            {
              "enabled": true,
              "id": "graphql-get-query",
              "key": "query",
              "value": "query Q($id: ID!) { node(id: $id) { id } }",
            },
            {
              "enabled": true,
              "id": "graphql-get-variables",
              "key": "variables",
              "value": "{"id":"42"}",
            },
            {
              "enabled": true,
              "id": "graphql-get-operationName",
              "key": "operationName",
              "value": "Q",
            },
            {
              "enabled": true,
              "id": "graphql-get-extensions",
              "key": "extensions",
              "value": "{"persistedQuery":{"version":1,"sha256Hash":"abc"}}",
            },
          ],
          "settings": {
            "encodeUrlAutomatically": true,
            "timeout": 1000,
          },
          "type": "http",
          "url": "https://api.example.com/graphql",
        },
      }
    `);
  });

  it('GET refusal', () => {
    expect(
      buildGraphQLWireRequest(req({ method: 'GET' }), { query: 'mutation { a }' })
    ).toMatchInlineSnapshot(`
      {
        "error": "GET can only send query operations — switch the method to POST to send this mutation.",
        "ok": false,
      }
    `);
  });

  it('POST with @defer', () => {
    expect(
      buildGraphQLWireRequest(req(), { query: '{ a ... @defer { b } }' })
    ).toMatchInlineSnapshot(`
      {
        "method": "POST",
        "ok": true,
        "request": {
          "auth": {
            "type": "none",
          },
          "body": {
            "raw": "{"query":"{ a ... @defer { b } }"}",
            "type": "json",
          },
          "headers": [
            {
              "enabled": true,
              "id": "h1",
              "key": "X-Trace",
              "value": "t",
            },
            {
              "enabled": true,
              "id": "graphql-accept",
              "key": "Accept",
              "value": "multipart/mixed;deferSpec=20220824, application/graphql-response+json;q=0.9, application/json;q=0.8",
            },
            {
              "enabled": true,
              "id": "graphql-content-type",
              "key": "Content-Type",
              "value": "application/json",
            },
          ],
          "id": "r1",
          "method": "POST",
          "name": "Q",
          "params": [
            {
              "enabled": true,
              "id": "p1",
              "key": "keep",
              "value": "1",
            },
            {
              "enabled": true,
              "id": "p2",
              "key": "query",
              "value": "stale",
            },
          ],
          "settings": {
            "encodeUrlAutomatically": false,
            "timeout": 1000,
          },
          "type": "http",
          "url": "https://api.example.com/graphql",
        },
      }
    `);
  });
});
