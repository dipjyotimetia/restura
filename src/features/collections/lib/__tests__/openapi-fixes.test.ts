import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import { importOpenAPICollection } from '../importers';
import type { ImportWarning } from '../importers/types';

function firstRequest(c: Awaited<ReturnType<typeof importOpenAPICollection>>): HttpRequest {
  const item = c.items[0];
  if (!item?.request) throw new Error('no request');
  return item.request as HttpRequest;
}

function doc(extra: Record<string, unknown>, op: Record<string, unknown> = {}, pathExtra = {}) {
  return {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths: { '/things/{id}': { ...pathExtra, get: { summary: 'get', responses: {}, ...op } } },
    ...extra,
  };
}

describe('OpenAPI import fixes', () => {
  it('dedupes path-level and operation-level params by (in,name); operation wins', async () => {
    const c = await importOpenAPICollection(
      doc(
        {},
        { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }] },
        {
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
            { name: 'sort', in: 'query', schema: { type: 'string', default: 'asc' } },
          ],
        }
      )
    );
    const r = firstRequest(c);
    expect(r.params.map((p) => [p.key, p.value])).toEqual([
      ['limit', '50'],
      ['sort', 'asc'],
    ]);
  });

  it('maps http scheme case-insensitively', async () => {
    const c = await importOpenAPICollection(
      doc(
        { components: { securitySchemes: { b: { type: 'http', scheme: 'Bearer' } } } },
        { security: [{ b: [] }] }
      )
    );
    expect(firstRequest(c).auth.type).toBe('bearer');
  });

  it('maps cookie apiKey to a Cookie header, not a header named after the cookie', async () => {
    const c = await importOpenAPICollection(
      doc(
        { components: { securitySchemes: { k: { type: 'apiKey', in: 'cookie', name: 'sid' } } } },
        { security: [{ k: [] }] }
      )
    );
    const r = firstRequest(c);
    expect(r.auth.type).toBe('none');
    expect(r.headers.find((h) => h.key === 'sid')).toBeUndefined();
    expect(r.headers.find((h) => h.key === 'Cookie')?.value).toBe('sid=');
  });

  it('warns for unmapped openIdConnect', async () => {
    const warnings: ImportWarning[] = [];
    const c = await importOpenAPICollection(
      doc(
        {
          components: {
            securitySchemes: {
              o: { type: 'openIdConnect', openIdConnectUrl: 'https://x/.well-known' },
            },
          },
        },
        { security: [{ o: [] }] }
      ),
      warnings
    );
    expect(firstRequest(c).auth.type).toBe('none');
    expect(
      warnings.some((w) => w.kind === 'unmodelled-construct' && /openIdConnect/.test(w.detail))
    ).toBe(true);
  });

  it('keeps falsy media-type examples (0 / false)', async () => {
    const mk = (example: unknown) =>
      doc(
        {},
        {
          requestBody: {
            content: { 'application/json': { example, schema: { type: 'integer' } } },
          },
        }
      );
    const zero = firstRequest(await importOpenAPICollection(mk(0)));
    expect(zero.body.raw).toBe('0');
    const no = firstRequest(await importOpenAPICollection(mk(false)));
    expect(no.body.raw).toBe('false');
  });

  it('defines collection variables for path params', async () => {
    const c = await importOpenAPICollection(
      doc(
        {},
        {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'abc' } },
          ],
        }
      )
    );
    expect(firstRequest(c).url).toBe('{{baseUrl}}/things/{{id}}');
    expect(c.variables?.find((v) => v.key === 'id')?.value).toBe('abc');
  });

  it('notes non-primary servers', async () => {
    const warnings: ImportWarning[] = [];
    await importOpenAPICollection(
      doc({
        servers: [{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }],
      }),
      warnings
    );
    expect(
      warnings.some((w) => w.kind === 'unmodelled-construct' && /b\.example\.com/.test(w.detail))
    ).toBe(true);
  });
});
