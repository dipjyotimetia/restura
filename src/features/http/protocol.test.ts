import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@/features/registry/types';
import type { HttpRequest } from '@/types';

const executeRequestMock = vi.hoisted(() => vi.fn());
vi.mock('@/features/http/lib/requestExecutor', () => ({ executeRequest: executeRequestMock }));
vi.mock('@/store/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
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
