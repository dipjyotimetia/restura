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
});
