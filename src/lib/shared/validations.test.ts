import { describe, expect, it } from 'vitest';
import { collectionItemSchema } from './validations';

/**
 * Regression coverage for the request `discriminatedUnion('type', …)` inside
 * `collectionItemSchema`. There was previously no test for this schema, and the
 * union is discriminated so a malformed request reports the real `type`
 * mismatch instead of trying every arm.
 */
describe('collectionItemSchema request union', () => {
  const httpRequest = {
    id: 'r1',
    name: 'GET x',
    type: 'http',
    method: 'GET',
    url: 'https://example.com',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };

  it('accepts a valid http request', () => {
    const result = collectionItemSchema.safeParse({
      id: '1',
      name: 'req',
      type: 'request',
      request: httpRequest,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a request whose type is not a known protocol', () => {
    const result = collectionItemSchema.safeParse({
      id: '1',
      name: 'req',
      type: 'request',
      request: { ...httpRequest, type: 'telnet' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a folder with nested items (recursive)', () => {
    const result = collectionItemSchema.safeParse({
      id: 'f1',
      name: 'folder',
      type: 'folder',
      items: [{ id: '1', name: 'req', type: 'request', request: httpRequest }],
    });
    expect(result.success).toBe(true);
  });
});
