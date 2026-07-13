import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeProxiedRequest } = vi.hoisted(() => ({ executeProxiedRequest: vi.fn() }));
vi.mock('@/lib/shared/transport', () => ({ executeProxiedRequest }));

import { loadContractSpec } from '../specLoader';

describe('loadContractSpec URL transport', () => {
  beforeEach(() => executeProxiedRequest.mockReset());

  it('loads URL specs through the SSRF-guarded proxy transport', async () => {
    executeProxiedRequest.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { openapi: '3.0.0', info: { title: 'Demo', version: '1' }, paths: {} },
    });

    const result = await loadContractSpec({
      source: 'url',
      url: 'https://example.com/openapi.json',
    });

    expect(result.ok).toBe(true);
    expect(executeProxiedRequest).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://example.com/openapi.json',
      headers: { Accept: 'application/json, application/yaml, text/yaml, */*' },
    });
  });

  it('decodes proxy base64 bodies for YAML media types', async () => {
    const yaml = 'openapi: 3.0.0\ninfo: { title: Demo, version: "1" }\npaths: {}\n';
    executeProxiedRequest.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/yaml' },
      data: btoa(yaml),
      bodyEncoding: 'base64',
    });

    const result = await loadContractSpec({
      source: 'url',
      url: 'https://example.com/openapi.yaml',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.openapi).toBe('3.0.0');
  });

  it('parses inline OpenAPI 3.1 JSON with the 2020-12 dialect', async () => {
    const result = await loadContractSpec({
      source: 'inline',
      inline: JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Demo', version: '1' },
        paths: {},
      }),
    });
    expect(result).toMatchObject({ ok: true, schemaDialect: '2020-12' });
  });

  it.each([
    [{ source: 'inline' as const }, 'inline spec has empty content'],
    [{ source: 'url' as const }, 'url spec has empty url field'],
    [{ source: 'file' as const }, 'file spec has empty filePath'],
    [{ source: 'unknown' as 'inline' }, 'Unknown spec source'],
  ])('reports source load errors for %o', async (source, message) => {
    const result = await loadContractSpec(source);
    expect(result).toMatchObject({ ok: false, stage: 'load' });
    if (!result.ok) expect(result.error).toContain(message);
  });

  it('reports malformed inline JSON as a parse error', async () => {
    const result = await loadContractSpec({ source: 'inline', inline: '{broken' });
    expect(result).toMatchObject({ ok: false, stage: 'parse' });
  });

  it('reports non-success proxy responses as load errors', async () => {
    executeProxiedRequest.mockResolvedValue({
      status: 404,
      statusText: 'Not Found',
      headers: {},
      data: 'missing',
    });
    const result = await loadContractSpec({ source: 'url', url: 'https://example.com/missing' });
    expect(result).toMatchObject({ ok: false, stage: 'load' });
  });

  it('parses a textual YAML proxy response', async () => {
    executeProxiedRequest.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: 'openapi: 3.0.0\ninfo: { title: Demo, version: "1" }\npaths: {}\n',
    });
    const result = await loadContractSpec({ source: 'url', url: 'https://example.com/spec' });
    expect(result).toMatchObject({ ok: true, schemaDialect: 'draft-07' });
  });

  it('rejects desktop file sources on web with a clear load error', async () => {
    const result = await loadContractSpec({ source: 'file', filePath: '/tmp/openapi.yaml' });
    expect(result).toMatchObject({ ok: false, stage: 'load' });
  });
});
