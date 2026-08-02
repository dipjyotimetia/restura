import { describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  getElectronAPI: vi.fn(),
  workerAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer test' })),
  workerBaseUrl: vi.fn(() => 'https://worker.example'),
}));

vi.mock('@/lib/shared/platform', () => platform);

import { detectRemoteFormat, fetchRemoteArtifact } from '../import-dialog-data';

describe('detectRemoteFormat', () => {
  it.each([
    ['Bruno extension', 'ignored', 'https://example.com/request.bru', 'bruno'],
    ['HTTP extension', 'ignored', 'https://example.com/request.rest', 'http'],
    ['Bruno signature', 'meta {\n  name: sample\n}', 'https://example.com/source', 'bruno'],
    [
      'HTTP signature',
      '### request\nGET https://api.example.com',
      'https://example.com/source',
      'http',
    ],
    [
      'OpenCollection JSON',
      '{"opencollection":"1.0.0"}',
      'https://example.com/a.json',
      'opencollection',
    ],
    ['OpenAPI JSON', '{"openapi":"3.0.0"}', 'https://example.com/a.json', 'openapi'],
    ['Swagger YAML', 'swagger: "2.0"', 'https://example.com/a.yaml', 'openapi'],
    [
      'Postman JSON',
      '{"info":{"schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"}}',
      'https://example.com/a.json',
      'postman',
    ],
    ['Insomnia type', '{"_type":"export"}', 'https://example.com/a.json', 'insomnia'],
    ['Insomnia resources', '{"resources":[]}', 'https://example.com/a.json', 'insomnia'],
    ['Hoppscotch requests', '{"v":1,"requests":[]}', 'https://example.com/a.json', 'hoppscotch'],
    ['Hoppscotch folders', '{"v":1,"folders":[]}', 'https://example.com/a.json', 'hoppscotch'],
  ])('recognizes %s', (_label, text, url, expected) => {
    expect(detectRemoteFormat(text, url)).toBe(expected);
  });

  it.each(['null', '[]', '{}', '{"v":1}'])('rejects unsupported content %s', (text) => {
    expect(() => detectRemoteFormat(text, 'https://example.com/source')).toThrow(
      /supported|detected/i
    );
  });
});

describe('fetchRemoteArtifact', () => {
  it('uses the Electron deep-link fetcher and surfaces its failure', async () => {
    const fetchImport = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: 'GET https://api.example.com' });
    platform.getElectronAPI.mockReturnValue({ deepLinks: { fetchImport } });

    await expect(fetchRemoteArtifact('https://example.com/request.http')).resolves.toContain('GET');

    fetchImport.mockResolvedValueOnce({ ok: false, error: 'remote source blocked' });
    await expect(fetchRemoteArtifact('https://example.com/request.http')).rejects.toThrow(
      'remote source blocked'
    );
  });

  it('uses the bounded Worker endpoint and reports malformed or failed responses', async () => {
    platform.getElectronAPI.mockReturnValue(undefined);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'meta { name: example }' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'blocked by policy' }), { status: 400 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);

    await expect(fetchRemoteArtifact('https://example.com/collection.bru')).resolves.toContain(
      'meta'
    );
    await expect(fetchRemoteArtifact('https://example.com/blocked')).rejects.toThrow(
      'blocked by policy'
    );
    await expect(fetchRemoteArtifact('https://example.com/malformed')).rejects.toThrow(
      'Remote import failed.'
    );

    expect(fetcher).toHaveBeenCalledWith(
      'https://worker.example/api/import/fetch',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test' }),
      })
    );
    vi.unstubAllGlobals();
  });
});
