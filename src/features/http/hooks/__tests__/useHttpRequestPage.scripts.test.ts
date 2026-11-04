import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as platformModule from '@/lib/shared/platform';

vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof platformModule>()),
  isElectron: () => false,
}));

vi.mock('@/components/shared/AriaLiveAnnouncer', () => ({
  useRequestAnnouncements: () => ({
    announceRequestSent: vi.fn(),
    announceRequestComplete: vi.fn(),
    announceRequestFailed: vi.fn(),
  }),
}));

vi.mock('axios', () => {
  const post = vi.fn().mockResolvedValue({
    data: { status: 200, statusText: 'OK', headers: {}, data: { id: 'u-7' } },
  });
  const mockAxios = Object.assign(vi.fn(), { post });
  return { default: mockAxios, isAxiosError: () => false };
});

describe('useHttpRequestPage — script environment writes', () => {
  beforeEach(() => vi.resetModules());

  it('persists pm.environment writes from both scripts to the active environment', async () => {
    const { useEnvironmentStore } = await import('@/store/useEnvironmentStore');
    const { useRequestStore } = await import('@/store/useRequestStore');

    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env1',
          name: 'Env',
          variables: [
            { id: 'v1', key: 'baseUrl', value: 'https://example.com', enabled: true },
            { id: 'v2', key: 'stale', value: 'x', enabled: true },
          ],
        },
      ],
      activeEnvironmentId: 'env1',
    });
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab1',
          isDirty: false,
          request: {
            id: 'req-1',
            name: 'Login',
            type: 'http',
            method: 'GET',
            url: '{{baseUrl}}/login',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'none' },
            preRequestScript: `rs.environment.set('nonce', 'n-1'); rs.environment.unset('stale');`,
            testScript: `rs.environment.set('user_id', rs.response.json().id);`,
          },
        },
      ],
      activeTabId: 'tab1',
      isLoading: false,
    });

    const { useHttpRequestPage } = await import('../useHttpRequestPage');
    const { result } = renderHook(() => useHttpRequestPage());
    await act(async () => {
      await result.current.handlers.sendRequest();
    });

    const variables = useEnvironmentStore.getState().environments[0]?.variables ?? [];
    expect(Object.fromEntries(variables.map((v) => [v.key, v.value]))).toEqual({
      baseUrl: 'https://example.com',
      nonce: 'n-1',
      user_id: 'u-7',
    });
  });
});
