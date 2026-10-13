import { describe, expect, it } from 'vitest';
import type { Collection } from '@/types';
import { validateImportedCollection } from '../importers/validateImported';

const valid: Collection = {
  id: 'c1',
  name: 'Valid',
  items: [
    {
      id: 'i1',
      name: 'R',
      type: 'request',
      request: {
        id: 'r1',
        name: 'R',
        type: 'http',
        method: 'GET',
        url: 'https://example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      },
    },
  ],
};

describe('validateImportedCollection', () => {
  it('accepts a canonical collection', () => {
    expect(validateImportedCollection(valid)).toEqual({ ok: true });
  });

  it('accepts unknown passthrough keys (e.g. OpenCollection _oc bag)', () => {
    const withBag = { ...valid, _oc: { raw: 'spec' } } as unknown as Collection;
    expect(validateImportedCollection(withBag)).toEqual({ ok: true });
  });

  it('accepts folder auth, variables, and contractSpec', () => {
    const rich: Collection = {
      ...valid,
      variables: [{ id: 'v', key: 'k', value: 'v', enabled: true }],
      contractSpec: { source: 'url', url: 'https://x/openapi.yaml' },
      items: [
        {
          id: 'f1',
          name: 'F',
          type: 'folder',
          auth: { type: 'bearer', bearer: { token: 't' } },
          items: valid.items,
        },
      ],
    };
    expect(validateImportedCollection(rich)).toEqual({ ok: true });
  });

  it('rejects a request with an invalid method, naming the path', () => {
    const bad = structuredClone(valid) as unknown as {
      items: Array<{ request: { method: string } }>;
    };
    bad.items[0]!.request.method = 'NOT A TOKEN';
    const result = validateImportedCollection(bad as unknown as Collection);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join(' ')).toContain('items');
    }
  });

  it('accepts an RFC 9110 extension method token', () => {
    const custom = structuredClone(valid) as unknown as {
      items: Array<{ request: { method: string } }>;
    };
    custom.items[0]!.request.method = 'PROPFIND';
    expect(validateImportedCollection(custom as unknown as Collection)).toEqual({ ok: true });
  });

  it('rejects a collection with a missing name', () => {
    const result = validateImportedCollection({ ...valid, name: '' });
    expect(result.ok).toBe(false);
  });
});
