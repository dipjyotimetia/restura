// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseJsonBody } from '../validate-body';

describe('parseJsonBody', () => {
  const schema = z.object({ method: z.string(), url: z.url() });

  it('returns parsed value for valid input', async () => {
    const req = new Request('https://x/', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: 'https://example.com' }),
    });
    const result = await parseJsonBody(req, schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.method).toBe('GET');
  });

  it('returns 400 details for invalid JSON', async () => {
    const req = new Request('https://x/', { method: 'POST', body: '{not json' });
    const result = await parseJsonBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/Malformed JSON/);
    }
  });

  it('returns 400 details for schema violation', async () => {
    const req = new Request('https://x/', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: 'not-a-url' }),
    });
    const result = await parseJsonBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/url/i);
    }
  });

  it('returns 400 details for missing required field', async () => {
    const req = new Request('https://x/', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    const result = await parseJsonBody(req, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/method/i);
    }
  });

  it('rejects with 413 when Content-Length exceeds maxBytes', async () => {
    const req = new Request('https://x/', {
      method: 'POST',
      headers: { 'content-length': '100000' },
      body: JSON.stringify({ method: 'GET', url: 'https://example.com' }),
    });
    const result = await parseJsonBody(req, schema, { maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
      expect(result.error).toMatch(/too large/i);
    }
  });

  it('accepts a body whose Content-Length is within maxBytes', async () => {
    const body = JSON.stringify({ method: 'GET', url: 'https://example.com' });
    const req = new Request('https://x/', {
      method: 'POST',
      headers: { 'content-length': String(body.length) },
      body,
    });
    const result = await parseJsonBody(req, schema, { maxBytes: 64 * 1024 });
    expect(result.ok).toBe(true);
  });

  it('skips the size pre-check when Content-Length is absent', async () => {
    // No content-length header (e.g. chunked) → falls through to schema validation.
    const req = new Request('https://x/', {
      method: 'POST',
      body: JSON.stringify({ method: 'GET', url: 'https://example.com' }),
    });
    const result = await parseJsonBody(req, schema, { maxBytes: 1 });
    expect(result.ok).toBe(true);
  });
});
