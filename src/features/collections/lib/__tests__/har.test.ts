import { describe, expect, it } from 'vitest';
import { internalToOC } from '@/lib/opencollection';
import { buildHarImportCollections, parseHarImport } from '../importers/har';

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
