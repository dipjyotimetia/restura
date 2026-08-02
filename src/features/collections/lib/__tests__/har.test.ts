import { describe, expect, it } from 'vitest';
import { internalToOC } from '@/lib/opencollection';
import { buildHarImportCollections, parseHarImport } from '../importers/har';
import { summarizeWarnings } from '../importers/types';

const HAR = JSON.stringify({
  log: {
    version: '1.2',
    creator: { name: 'Chrome', version: '1' },
    pages: [{ id: 'page-1', title: 'Checkout', startedDateTime: '2026-08-02T00:00:00.000Z' }],
    entries: [
      {
        startedDateTime: '2026-08-02T00:00:01.000Z',
        time: 42,
        pageref: 'page-1',
        request: {
          method: 'POST',
          url: 'https://api.example.test/orders?access_token=top-secret',
          headers: [
            { name: 'Authorization', value: 'Bearer top-secret' },
            { name: 'Cookie', value: 'session=top-secret' },
            { name: 'Content-Type', value: 'application/json' },
          ],
          cookies: [{ name: 'session', value: 'top-secret' }],
          postData: { mimeType: 'application/json', text: '{"api_key":"top-secret"}' },
        },
        response: {
          status: 302,
          statusText: 'Found',
          headers: [{ name: 'Location', value: 'https://app.example.test/cb?code=top-secret' }],
          cookies: [{ name: 'session', value: 'top-secret' }],
          content: { mimeType: 'text/html', text: '<script>top-secret</script>' },
          redirectURL: 'https://app.example.test/cb',
        },
        timings: { wait: 42 },
      },
    ],
  },
});

describe('HAR importer', () => {
  it('creates a redacted page-first preview and only builds selected collections', () => {
    const preview = parseHarImport(HAR);

    expect(preview.groups).toHaveLength(1);
    expect(preview.groups[0]).toMatchObject({ id: 'page:page-1', name: 'Checkout' });
    expect(preview.groups[0]?.entries[0]).toMatchObject({
      name: 'POST /orders',
      stateChanging: true,
      selected: true,
    });
    expect(JSON.stringify(preview)).not.toContain('top-secret');
    expect(preview.warnings.some((warning) => warning.kind === 'har-cookies-discarded')).toBe(true);
    expect(preview.warnings.some((warning) => warning.kind === 'har-redirect')).toBe(true);
    expect(preview.warnings.some((warning) => warning.kind === 'har-response-discarded')).toBe(
      true
    );
    expect(preview.environmentCandidates).toEqual([
      {
        id: 'environment:page:page-1',
        groupId: 'page:page-1',
        name: 'Checkout environment',
        baseUrl: 'https://api.example.test',
      },
    ]);

    expect(buildHarImportCollections(preview, new Set())).toEqual([]);

    const collections = buildHarImportCollections(
      preview,
      new Set([preview.groups[0]!.entries[0]!.id])
    );
    expect(collections).toHaveLength(1);
    expect(JSON.stringify(collections)).not.toContain('top-secret');
    expect(collections[0]?.collection.items[0]?.request).toMatchObject({
      method: 'POST',
      url: 'https://api.example.test/orders?access_token={{accessToken}}',
    });
    const withEnvironment = buildHarImportCollections(
      preview,
      new Set([preview.groups[0]!.entries[0]!.id]),
      new Set(['environment:page:page-1'])
    );
    expect(withEnvironment[0]?.environments?.[0]).toMatchObject({
      name: 'Checkout environment',
      variables: [expect.objectContaining({ key: 'baseUrl', value: 'https://api.example.test' })],
    });
  });

  it('rejects malformed or oversized HAR input before constructing a preview', () => {
    expect(() => parseHarImport('{"log": {"version": "1.1"}}')).toThrow(/HAR 1.2/i);
    expect(() => parseHarImport('x'.repeat(16 * 1024 * 1024 + 1))).toThrow(/maximum size/i);
  });

  it('discards malformed or non-HTTP entry URLs before they reach the preview', () => {
    const preview = parseHarImport(
      JSON.stringify({
        log: {
          version: '1.2',
          entries: [
            {
              request: {
                method: 'GET',
                url: 'not a URL?access_token=top-secret',
                headers: [],
              },
            },
            {
              request: {
                method: 'GET',
                url: 'https://api.example.test/health',
                headers: [],
              },
            },
          ],
        },
      })
    );

    expect(preview.groups[0]?.entries).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain('top-secret');
    expect(preview.warnings).toContainEqual(
      expect.objectContaining({ kind: 'har-entry-discarded', reason: 'invalid HTTP URL' })
    );
  });

  it('redacts form parameters even when HAR omits postData.text', () => {
    const preview = parseHarImport(
      JSON.stringify({
        log: {
          version: '1.2',
          entries: [
            {
              request: {
                method: 'POST',
                url: 'https://api.example.test/login',
                headers: [],
                postData: {
                  mimeType: 'application/x-www-form-urlencoded',
                  params: [
                    { name: 'api_key', value: 'form-secret' },
                    { name: 'email', value: 'a@example.test' },
                  ],
                },
              },
            },
          ],
        },
      })
    );

    const request = preview.groups[0]?.entries[0]?.request;
    expect(JSON.stringify(request)).not.toContain('form-secret');
    expect(request?.body.formData?.find((part) => part.key === 'api_key')?.value).toBe(
      '{{apiKey}}'
    );
  });

  it('preserves representable multipart metadata and warns for base64 request bodies', () => {
    const preview = parseHarImport(
      JSON.stringify({
        log: {
          version: '1.2',
          entries: [
            {
              request: {
                method: 'POST',
                url: 'https://api.example.test/upload',
                headers: [],
                postData: {
                  mimeType: 'multipart/form-data; boundary=abc',
                  params: [
                    {
                      name: 'document',
                      value: 'captured-file-content',
                      fileName: 'invoice.pdf',
                      contentType: 'application/pdf',
                    },
                  ],
                },
              },
            },
            {
              request: {
                method: 'POST',
                url: 'https://api.example.test/binary',
                headers: [],
                postData: {
                  mimeType: 'application/octet-stream',
                  encoding: 'base64',
                  text: 'AAE=',
                },
              },
            },
          ],
        },
      })
    );

    const [multipart, binary] = preview.groups[0]!.entries;
    expect(multipart?.request.body).toMatchObject({
      type: 'form-data',
      formData: [
        expect.objectContaining({
          key: 'document',
          type: 'file',
          fileName: 'invoice.pdf',
          contentType: 'application/pdf',
        }),
      ],
    });
    expect(binary?.request.body).toMatchObject({ type: 'text', raw: 'AAE=' });
    expect(preview.warnings.some((warning) => warning.kind === 'har-lossy-body')).toBe(true);
  });

  it('keeps usable requests while surfacing malformed fields, duplicates, assets, and lossy responses', () => {
    const preview = parseHarImport(
      JSON.stringify({
        log: {
          version: '1.2',
          pages: [null, { id: 'unknown-page' }],
          entries: [
            { request: { method: 'GET', headers: [] } },
            {
              pageref: 'unknown-page',
              request: {
                url: 'https://api.example.test/one',
                headers: [{ name: 'Accept', value: 'application/json' }, { name: 1 }],
                postData: { mimeType: 'application/xml', text: '<ok />' },
              },
              response: { status: 200, content: { size: 12 } },
            },
            {
              pageref: 'unknown-page',
              request: {
                method: 'GET',
                url: 'https://api.example.test/one',
                headers: [{ name: 'Accept', value: 'application/json' }],
                postData: { mimeType: 'application/xml', text: '<ok />' },
              },
            },
            {
              pageref: 'unknown-page',
              request: {
                method: 'GET',
                url: 'https://cdn.example.test/logo.png',
                headers: [{ name: 'Accept', value: 'image/png' }],
              },
            },
          ],
        },
      })
    );

    expect(preview.groups).toHaveLength(1);
    expect(preview.groups[0]).toMatchObject({ id: 'page:unknown-page', name: 'unknown-page' });
    expect(preview.groups[0]?.entries.map((entry) => entry.selected)).toEqual([true, false, false]);
    expect(preview.groups[0]?.entries[0]?.request.body).toMatchObject({
      type: 'xml',
      raw: '<ok />',
    });
    expect(preview.environmentCandidates).toEqual([]);
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'har-entry-discarded', reason: 'missing URL' }),
        expect.objectContaining({ kind: 'har-field-discarded', field: 'malformed header' }),
        expect.objectContaining({ kind: 'har-response-discarded' }),
      ])
    );
  });

  it('maps urlencoded bodies without params and records malformed form fields', () => {
    const preview = parseHarImport(
      JSON.stringify({
        log: {
          version: '1.2',
          entries: [
            {
              request: {
                method: 'POST',
                url: 'https://api.example.test/token',
                headers: [],
                postData: {
                  mimeType: 'application/x-www-form-urlencoded',
                  text: 'grant_type=client_credentials&client_secret=top-secret',
                },
              },
            },
            {
              request: {
                method: 'POST',
                url: 'https://api.example.test/form',
                headers: [],
                postData: {
                  mimeType: 'multipart/form-data',
                  params: [null, { name: 'empty-value' }],
                },
              },
            },
          ],
        },
      })
    );

    const [urlencoded, multipart] = preview.groups[0]!.entries;
    expect(urlencoded?.request.body).toMatchObject({
      type: 'x-www-form-urlencoded',
      formData: [
        expect.objectContaining({ key: 'grant_type', value: 'client_credentials' }),
        expect.objectContaining({ key: 'client_secret', value: '{{clientSecret}}' }),
      ],
    });
    expect(JSON.stringify(urlencoded)).not.toContain('top-secret');
    expect(multipart?.request.body).toMatchObject({
      type: 'form-data',
      formData: [expect.objectContaining({ key: 'empty-value', value: '', type: 'text' })],
    });
    expect(preview.warnings).toContainEqual(
      expect.objectContaining({ kind: 'har-field-discarded', field: 'malformed form field' })
    );
  });

  it('rejects malformed HAR structures and per-entry resource bounds', () => {
    const entries = Array.from({ length: 10_001 }, () => ({}));
    const deeplyNested = { log: { version: '1.2', entries: [] as unknown[] } };
    let cursor: Record<string, unknown> = deeplyNested;
    for (let depth = 0; depth < 33; depth += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }

    expect(() => parseHarImport(JSON.stringify({ log: { version: '1.2' } }))).toThrow(/entries/i);
    expect(() => parseHarImport(JSON.stringify({ log: { version: '1.2', entries } }))).toThrow(
      /10,000/i
    );
    expect(() => parseHarImport(JSON.stringify(deeplyNested))).toThrow(/nesting/i);
    expect(() => parseHarImport('[]')).toThrow(/HAR document must be an object/i);
    expect(() =>
      parseHarImport(
        JSON.stringify({
          log: {
            version: '1.2',
            entries: [{ request: { method: 'GET', url: 'ftp://example.test/file' } }],
          },
        })
      )
    ).toThrow(/no importable requests/i);
    expect(() =>
      parseHarImport(
        JSON.stringify({
          log: {
            version: '1.2',
            entries: [
              {
                request: {
                  method: 'POST',
                  url: 'https://api.example.test/large',
                  headers: [],
                  postData: { text: 'x'.repeat(1024 * 1024 + 1) },
                },
              },
            ],
          },
        })
      )
    ).toThrow(/body exceeds/i);
    expect(() =>
      parseHarImport(
        JSON.stringify({
          log: {
            version: '1.2',
            entries: [
              {
                request: {
                  method: 'GET',
                  url: 'https://api.example.test/many-headers',
                  headers: Array.from({ length: 201 }, () => ({ name: 'X-Test', value: 'ok' })),
                },
              },
            ],
          },
        })
      )
    ).toThrow(/exceeds 200 headers/i);
    expect(() =>
      parseHarImport(
        JSON.stringify({
          log: {
            version: '1.2',
            entries: [
              {
                request: {
                  method: 'GET',
                  url: 'https://api.example.test/large-header',
                  headers: [{ name: 'X-Test', value: 'x'.repeat(64 * 1024 + 1) }],
                },
              },
            ],
          },
        })
      )
    ).toThrow(/oversized header/i);
  });

  it('uses page-reference fallback names and handles headerless plain-text captures', () => {
    const preview = parseHarImport(
      JSON.stringify({
        log: {
          version: '1.2',
          entries: [
            {
              pageref: 'missing-page',
              request: {
                method: 'POST',
                url: 'https://api.example.test/plain',
                postData: { text: 'plain capture' },
              },
              response: { content: 'not-a-record' },
            },
          ],
        },
      })
    );

    expect(preview.groups[0]).toMatchObject({ name: 'missing-page' });
    expect(preview.groups[0]?.entries[0]?.request).toMatchObject({
      headers: [],
      body: { type: 'text', raw: 'plain capture' },
    });
  });

  it('summarizes every HAR conversion warning for non-UI consumers', () => {
    const summaries = summarizeWarnings([
      { kind: 'har-cookies-discarded', requestName: 'cookies' },
      { kind: 'har-redirect', requestName: 'redirect', status: 301 },
      { kind: 'har-response-discarded', requestName: 'response' },
      { kind: 'har-entry-discarded', entry: 'Entry 1', reason: 'missing URL' },
      { kind: 'har-field-discarded', requestName: 'field', field: 'bad header' },
      { kind: 'har-lossy-body', requestName: 'body', detail: 'base64 body retained as text' },
    ]);

    expect(summaries).toHaveLength(6);
    expect(summaries.map((summary) => summary.sample)).toEqual(
      expect.arrayContaining([
        'Cookies were discarded from "cookies"',
        'Redirect (301) captured for "redirect"',
        'Response content was discarded from "response"',
        'Entry 1 was discarded: missing URL',
        'bad header was discarded from "field"',
        'base64 body retained as text in "body"',
      ])
    );
  });

  it('keeps selected HAR provenance in the OpenCollection round trip', () => {
    const preview = parseHarImport(HAR);
    const collection = buildHarImportCollections(
      preview,
      new Set([preview.groups[0]!.entries[0]!.id])
    )[0]!.collection;

    const exported = internalToOC(collection);
    expect(exported.extensions?.['x-restura-har']).toEqual([
      expect.objectContaining({ pageRef: 'page-1', timeMs: 42 }),
    ]);
  });
});
