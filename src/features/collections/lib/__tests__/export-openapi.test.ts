import { describe, expect, it } from 'vitest';
import type { Collection, HttpRequest } from '@/types';
import { exportToOpenAPI } from '../exporters';

const req = (id: string, method: string, url: string): Collection['items'][number] => ({
  id,
  name: id,
  type: 'request',
  request: {
    id,
    name: id,
    type: 'http',
    method,
    url,
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  } satisfies HttpRequest,
});

const collection = (items: Collection['items']): Collection => ({
  id: 'c',
  name: 'C',
  items,
});

type Doc = { paths: Record<string, Record<string, unknown>> };

describe('exportToOpenAPI — extension methods (#857)', () => {
  it('skips methods that are not OpenAPI 3.0 operation keys, with a warning', () => {
    const warnings: string[] = [];
    const doc = exportToOpenAPI(
      collection([
        req('list', 'GET', 'https://api.example.com/items'),
        req('find', 'PROPFIND', 'https://api.example.com/items'),
        req('only-ext', 'QUERY', 'https://api.example.com/search'),
      ]),
      warnings
    ) as Doc;

    expect(Object.keys(doc.paths['/items'] ?? {})).toEqual(['get']);
    expect(doc.paths).not.toHaveProperty('/search');
    expect(warnings).toEqual([
      'OpenAPI 3.0 has no operation for PROPFIND — skipped "find"',
      'OpenAPI 3.0 has no operation for QUERY — skipped "only-ext"',
    ]);
  });

  it('maps a stored lower-case known method onto its operation key', () => {
    const doc = exportToOpenAPI(
      collection([req('create', 'post', 'https://api.example.com/items')])
    ) as Doc;
    expect(Object.keys(doc.paths['/items'] ?? {})).toEqual(['post']);
  });
});
