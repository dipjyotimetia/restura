import { describe, expect, it } from 'vitest';
import type { Response } from '../types/http';
import {
  buildResponseEvidence,
  evidenceBytes,
  RESPONSE_EVIDENCE_LIMITS,
  type ResponseEvidence,
} from './evidence';

function response(overrides: Partial<Response> = {}): Response {
  return {
    id: 'response',
    requestId: 'request',
    status: 500,
    statusText: 'Error',
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
    body: '{"message":"nope"}',
    size: 18,
    time: 1,
    timestamp: 1,
    ...overrides,
  };
}

describe('buildResponseEvidence', () => {
  it('keeps only safe headers and redacts sensitive response content before hashing', async () => {
    const evidence = await buildResponseEvidence(
      response({
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret-value',
          location: 'https://example.test/callback?access_token=abc123456789',
          'x-request-id': 'req-1',
        },
        body: '{"token":"super-secret-value","ok":false}',
      }),
      'all'
    );

    expect(evidence).toMatchObject({
      contentType: 'application/json',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
      redacted: true,
      truncated: false,
    });
    expect(evidence.excerpt).not.toContain('super-secret-value');
    expect(evidence.headers).not.toHaveProperty('authorization');
    expect(evidence.headers).not.toHaveProperty('location');
    expect(evidence.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('marks oversized excerpts as truncated while retaining the sanitized hash', async () => {
    const evidence = await buildResponseEvidence(
      response({ body: 'x'.repeat(RESPONSE_EVIDENCE_LIMITS.allExcerptBytes + 100) }),
      'all'
    );

    expect(evidence.excerpt).toHaveLength(RESPONSE_EVIDENCE_LIMITS.allExcerptBytes);
    expect(evidence.truncated).toBe(true);
    expect(evidence.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not retain or parse binary/base64 responses', async () => {
    const evidence = await buildResponseEvidence(
      response({
        headers: { 'content-type': 'image/png' },
        body: 'iVBORw0KGgoAAAANSUhEUg==',
        bodyEncoding: 'base64',
        size: 16,
      }),
      'all'
    );

    expect(evidence).toEqual({
      contentType: 'image/png',
      sizeBytes: 16,
      headers: { 'content-type': 'image/png' },
      binary: true,
      unavailable: true,
      redacted: false,
      truncated: false,
    });
  });

  it('returns metadata only when retention is disabled', async () => {
    const evidence = await buildResponseEvidence(response(), 'metadata');

    expect(evidence).toMatchObject({
      unavailable: true,
      binary: false,
      redacted: false,
      truncated: false,
    });
    expect(evidence.excerpt).toBeUndefined();
    expect(evidence.hash).toBeUndefined();
  });
});

describe('evidenceBytes', () => {
  it('counts only persisted evidence fields for deterministic quota enforcement', () => {
    const evidence: ResponseEvidence = {
      contentType: 'text/plain',
      sizeBytes: 3,
      headers: { 'content-type': 'text/plain' },
      excerpt: 'abc',
      hash: 'a'.repeat(64),
      truncated: false,
      redacted: false,
      binary: false,
      unavailable: false,
    };

    expect(evidenceBytes(evidence)).toBe(
      new TextEncoder().encode(JSON.stringify(evidence)).byteLength
    );
  });
});
