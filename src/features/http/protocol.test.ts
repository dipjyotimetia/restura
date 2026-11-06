import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@/features/registry/types';
import type { HttpRequest } from '@/types';

const executeRequestMock = vi.hoisted(() => vi.fn());
vi.mock('@/features/http/lib/requestExecutor', () => ({ executeRequest: executeRequestMock }));
vi.mock('@/store/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));
const transportMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => transportMock(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));
vi.mock('@/features/scripts/lib/pmSendRequestHost', () => ({
  makeRendererSendRequest: () => vi.fn(),
}));

import { httpProtocol } from './protocol';

const request: HttpRequest = {
  id: 'http-1',
  name: 'R',
  type: 'http',
  method: 'GET',
  url: 'https://api.example.com/me',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

describe('httpProtocol.runRequest', () => {
  beforeEach(() => {
    executeRequestMock.mockReset();
  });

  it('reports a refreshed OAuth2 auth through ctx.onAuthRefreshed', async () => {
    const refreshed = { type: 'oauth2', oauth2: { accessToken: 'fresh' } };
    executeRequestMock.mockResolvedValue({
      response: { status: 200 },
      scriptResult: undefined,
      refreshedAuth: refreshed,
    });
    const onAuthRefreshed = vi.fn();
    const ctx: RunContext = {
      signal: new AbortController().signal,
      variables: {},
      onAuthRefreshed,
    };
    await httpProtocol.runRequest(request, ctx);

    expect(onAuthRefreshed).toHaveBeenCalledWith(refreshed);
  });

  it('does not call onAuthRefreshed when nothing was refreshed', async () => {
    executeRequestMock.mockResolvedValue({ response: { status: 200 }, scriptResult: undefined });
    const onAuthRefreshed = vi.fn();
    const ctx: RunContext = {
      signal: new AbortController().signal,
      variables: {},
      onAuthRefreshed,
    };
    await httpProtocol.runRequest(request, ctx);

    expect(onAuthRefreshed).not.toHaveBeenCalled();
  });
});

// Through the real executor: the registry HTTP path must hand secret-handle
// variables to executeRequest as the GraphQL module and the HTTP tab do, or a
// handle token is neither materialized by Electron main nor refused (ADR-0007).
describe('httpProtocol.runRequest secret-handle variables (real executor)', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/features/http/lib/requestExecutor')>(
      '@/features/http/lib/requestExecutor'
    );
    executeRequestMock.mockReset();
    executeRequestMock.mockImplementation(actual.executeRequest);
    transportMock.mockReset();
    transportMock.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: '',
      size: 0,
      time: 1,
    });
  });

  const handleCtx = (): RunContext => ({
    signal: new AbortController().signal,
    variables: {},
    secretVariables: { apiKey: { kind: 'handle', id: 'h-1' } },
    secretNames: ['apiKey'],
  });

  it('hands the handle map to the desktop transport so main can materialize {{apiKey}}', async () => {
    await httpProtocol.runRequest(
      {
        ...request,
        headers: [{ id: 'h', key: 'X-Api-Key', value: '{{apiKey}}', enabled: true }],
      },
      handleCtx()
    );
    expect(transportMock).toHaveBeenCalledTimes(1);
    const [spec, , desktop] = transportMock.mock.calls[0] as [
      { headers: Record<string, string> },
      unknown,
      { secretVariables?: unknown } | undefined,
    ];
    expect(spec.headers['X-Api-Key']).toBe('{{apiKey}}');
    expect(desktop?.secretVariables).toEqual({ apiKey: { kind: 'handle', id: 'h-1' } });
  });
});
