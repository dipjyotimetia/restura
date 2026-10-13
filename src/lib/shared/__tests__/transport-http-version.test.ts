import { beforeEach, describe, expect, it, vi } from 'vitest';

// Desktop send path: the per-request httpVersion (#864) must survive the
// renderer → `http:request` IPC config mapping.
const request = vi.fn();

vi.mock('../platform', () => ({
  isElectron: () => true,
  getElectronAPI: () => ({ http: { request, cancel: vi.fn(async () => undefined) } }),
  workerAuthHeaders: () => ({}),
  workerBaseUrl: () => '',
}));

import { executeProxiedRequest } from '../transport';

describe('executeProxiedRequest — httpVersion', () => {
  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: '' });
  });

  it('forwards httpVersion into the Electron IPC config', async () => {
    await executeProxiedRequest(
      { method: 'GET', url: 'http://127.0.0.1:8090/' },
      {},
      { httpVersion: 'h2c-prior-knowledge' }
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ httpVersion: 'h2c-prior-knowledge' })
    );
  });

  it('omits httpVersion when not configured', async () => {
    await executeProxiedRequest({ method: 'GET', url: 'https://example.com/' }, {}, {});
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty('httpVersion');
  });
});
