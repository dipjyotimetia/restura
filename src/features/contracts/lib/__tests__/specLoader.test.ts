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
});
