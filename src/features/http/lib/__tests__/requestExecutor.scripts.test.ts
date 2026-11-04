import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest } from '@/types';

const executeProxiedRequestMock = vi.fn();

vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => executeProxiedRequestMock(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

vi.mock('@/features/scripts/lib/pmSendRequestHost', () => ({
  makeRendererSendRequest: () => vi.fn(),
}));

import { executeRequest } from '../requestExecutor';

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'request-id',
    name: 'Scripts',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/{{path}}',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

const settings = useSettingsStore.getState().settings;

function sentSpec(): { url: string; headers?: Record<string, string> } {
  return executeProxiedRequestMock.mock.calls[0]?.[0] as {
    url: string;
    headers?: Record<string, string>;
  };
}

describe('executeRequest — script variables and request edits', () => {
  beforeEach(() => {
    executeProxiedRequestMock.mockReset();
    executeProxiedRequestMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      data: '{"id":"u-42"}',
      size: 13,
    });
  });

  it('reports pm.environment writes from both phases for the caller to persist', async () => {
    const result = await executeRequest({
      request: makeRequest({
        preRequestScript: `pm.environment.set('path', 'users'); pm.environment.unset('stale');`,
        testScript: `pm.environment.set('user_id', pm.response.json().id);`,
      }),
      envVars: { stale: 'x' },
      globalSettings: settings,
      resolveVariables: (text, vars) => text.replace('{{path}}', vars?.path ?? '{{path}}'),
    });
    expect(result.environmentMutations).toEqual({ path: 'users', stale: null, user_id: 'u-42' });
    // A variable set in the pre-request script is used by the same request.
    expect(sentSpec().url).toBe('https://api.example.com/users');
  });

  it('keeps variable writes made before a pre-request script error', async () => {
    const result = await executeRequest({
      request: makeRequest({
        preRequestScript: `pm.variables.set('path', 'kept'); throw new Error('boom');`,
      }),
      envVars: {},
      globalSettings: settings,
      resolveVariables: (text, vars) => text.replace('{{path}}', vars?.path ?? '{{path}}'),
    });
    expect(result.scriptResult?.preRequest?.success).toBe(false);
    expect(result.envVars?.path).toBe('kept');
    expect(sentSpec().url).toBe('https://api.example.com/kept');
  });

  it('sends pm.request.headers edits made in the pre-request script', async () => {
    await executeRequest({
      request: makeRequest({
        url: 'https://api.example.com/x',
        headers: [
          { id: 'h1', key: 'X-Remove', value: 'r', enabled: true },
          { id: 'h2', key: 'Accept', value: 'application/xml', enabled: true },
        ],
        preRequestScript: `
          pm.request.headers.add({ key: 'X-Trace', value: 't-1' });
          pm.request.headers.upsert({ key: 'accept', value: 'application/json' });
          pm.request.headers.remove('X-Remove');
        `,
      }),
      envVars: {},
      globalSettings: settings,
      resolveVariables: (text) => text,
    });
    const headers = sentSpec().headers ?? {};
    expect(headers['X-Trace']).toBe('t-1');
    expect(headers.Accept).toBe('application/json');
    expect(headers['X-Remove']).toBeUndefined();
  });
});
