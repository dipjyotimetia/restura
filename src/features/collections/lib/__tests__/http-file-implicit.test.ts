import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import { importHttpFile } from '../importers/http-file';

function req(result: ReturnType<typeof importHttpFile>, i: number): HttpRequest {
  return result.collection.items[i]!.request as HttpRequest;
}

describe('importHttpFile implicit first block and continuation lines', () => {
  it('imports a single request with no ### separator', () => {
    const result = importHttpFile(`@host = https://api.example.com

GET {{host}}/users
Accept: application/json
`);
    expect(result.collection.items).toHaveLength(1);
    const r = req(result, 0);
    expect(r.method).toBe('GET');
    expect(r.url).toBe('{{host}}/users');
    expect(result.environments?.[0]?.variables).toHaveLength(1);
  });

  it('imports the implicit first request before later ### blocks', () => {
    const result = importHttpFile(`GET https://a.example.com/one

### Two
GET https://a.example.com/two
`);
    expect(result.collection.items).toHaveLength(2);
  });

  it('joins indented ?/& continuation lines into query params, not the body', () => {
    const result = importHttpFile(`### list
GET https://api.example.com/items
  ?page=1
  &size=10
Accept: application/json
`);
    const r = req(result, 0);
    expect(r.params.map((p) => [p.key, p.value])).toEqual([
      ['page', '1'],
      ['size', '10'],
    ]);
    expect(r.headers).toHaveLength(1);
    expect(r.body.type).toBe('none');
  });
});
