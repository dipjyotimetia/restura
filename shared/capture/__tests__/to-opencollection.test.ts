import { describe, expect, it } from 'vitest';
import { openCollectionSchema } from '@/lib/opencollection';
import { redactExchange } from '../secret-extractor';
import { sessionToOpenCollection } from '../to-opencollection';
import type { CaptureSession } from '../types';

const rawSession: CaptureSession = {
  id: 's1',
  createdAt: 0,
  origin: 'https://app.example.com',
  exchanges: [
    {
      id: '1',
      protocol: 'rest',
      method: 'POST',
      url: 'https://api.example.com/users',
      startedAt: 0,
      request: {
        headers: [
          { name: 'content-type', value: 'application/json' },
          { name: 'Authorization', value: 'Bearer supersecrettoken123' },
        ],
        body: { text: '{"name":"ada"}', mimeType: 'application/json' },
      },
      response: { status: 201, headers: [] },
    },
    {
      id: '2',
      protocol: 'graphql',
      method: 'POST',
      url: 'https://api.example.com/graphql',
      startedAt: 0,
      graphql: { operationName: 'GetUser', operationType: 'query' },
      request: {
        headers: [{ name: 'content-type', value: 'application/json' }],
        body: { text: '{"query":"query GetUser { user { id } }"}' },
      },
    },
  ],
};

function redactSession(): CaptureSession {
  return { ...rawSession, exchanges: rawSession.exchanges.map((e) => redactExchange(e).exchange) };
}

describe('sessionToOpenCollection', () => {
  it('emits a schema-valid OpenCollection document', () => {
    const doc = sessionToOpenCollection(redactSession(), { name: 'Captured' });
    const parsed = openCollectionSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    expect(doc.opencollection).toBe('1.0.0');
    expect(doc.items).toHaveLength(2);
  });

  it('maps a REST exchange to an http item and references secrets, never plaintext', () => {
    const doc = sessionToOpenCollection(redactSession());
    const json = JSON.stringify(doc);
    expect(json).not.toContain('supersecrettoken123');
    const http = doc.items[0];
    expect(http.info.type).toBe('http');
    expect(http.http?.method).toBe('POST');
    const auth = http.http?.headers?.find((h) => h.name === 'Authorization');
    expect(auth?.value).toBe('{{authorization}}');
  });

  it('maps a GraphQL exchange to a graphql item with the query', () => {
    const doc = sessionToOpenCollection(redactSession());
    const gql = doc.items[1];
    expect(gql.info.type).toBe('graphql');
    expect(gql.graphql?.query).toContain('GetUser');
  });

  it('declares captured secrets as secret environment variables', () => {
    const doc = sessionToOpenCollection(redactSession());
    const env = doc.config?.environments?.[0];
    expect(
      env?.variables?.some((v) => 'secret' in v && v.secret && v.name === 'authorization')
    ).toBe(true);
  });
});
