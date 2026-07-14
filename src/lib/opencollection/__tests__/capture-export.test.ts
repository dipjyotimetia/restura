/**
 * Integration: a captured session, exported by the shared capture core, must
 * produce a document that validates against the renderer's canonical
 * `openCollectionSchema` and re-imports cleanly via `ocToInternal`. Lives on the
 * renderer side because it bridges `@shared/capture` and `@/lib/opencollection`
 * (shared/ must never import src/).
 */

import { redactExchange } from '@shared/capture/secret-extractor';
import { sessionToOpenCollection } from '@shared/capture/to-opencollection';
import type { CaptureSession } from '@shared/capture/types';
import { describe, expect, it } from 'vitest';
import { ocToInternal, openCollectionSchema } from '@/lib/opencollection';

function capturedSession(): CaptureSession {
  const raw: CaptureSession = {
    id: 's1',
    createdAt: 0,
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
  return { ...raw, exchanges: raw.exchanges.map((e) => redactExchange(e).exchange) };
}

describe('capture → OpenCollection export', () => {
  it('validates against the canonical OpenCollection schema', () => {
    const doc = sessionToOpenCollection(capturedSession(), { name: 'Captured' });
    const parsed = openCollectionSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
  });

  it('re-imports through ocToInternal without throwing', () => {
    const doc = sessionToOpenCollection(capturedSession());
    const parsed = openCollectionSchema.parse(doc);
    expect(() => ocToInternal(parsed)).not.toThrow();
  });

  it('carries no plaintext secret into the imported document', () => {
    const doc = sessionToOpenCollection(capturedSession());
    expect(JSON.stringify(doc)).not.toContain('supersecrettoken123');
  });
});
