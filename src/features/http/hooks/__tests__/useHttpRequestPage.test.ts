import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as platformModule from '@/lib/shared/platform';

vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof platformModule>()),
  isElectron: () => false,
}));

// The web interactive Send converged on the shared executor, which posts the
// spec to the Worker `/api/proxy` via `axios.post` (see lib/shared/transport).
// Mock that wire shape: the Worker responds with a ProxyJsonResponse envelope.
vi.mock('axios', () => {
  const post = vi.fn().mockResolvedValue({
    data: { status: 200, statusText: 'OK', headers: {}, data: { ok: true } },
  });
  const mockAxios = Object.assign(vi.fn(), { post });
  return { default: mockAxios, isAxiosError: () => false };
});

describe('useHttpRequestPage — resolved URL persistence', () => {
  beforeEach(() => vi.resetModules());

  it('persists the resolved URL (not the raw {{var}} template) to history and console', async () => {
    const { useEnvironmentStore } = await import('@/store/useEnvironmentStore');
    const { useRequestStore } = await import('@/store/useRequestStore');
    const { useHistoryStore } = await import('@/store/useHistoryStore');
    const { useConsoleStore } = await import('@/store/useConsoleStore');

    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env1',
          name: 'Env',
          variables: [{ id: 'v1', key: 'baseUrl', value: 'https://example.com', enabled: true }],
        },
      ],
      activeEnvironmentId: 'env1',
    });

    const httpRequest = {
      id: 'req-1',
      name: 'Templated request',
      type: 'http' as const,
      method: 'GET' as const,
      url: '{{baseUrl}}/anything',
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth: { type: 'none' as const },
    };

    useRequestStore.setState({
      tabs: [{ id: 'tab1', request: httpRequest, isDirty: false }],
      activeTabId: 'tab1',
      isLoading: false,
    });
    useHistoryStore.setState({ history: [] });
    useConsoleStore.setState({ entries: [] });

    const { useHttpRequestPage } = await import('../useHttpRequestPage');
    const { result } = renderHook(() => useHttpRequestPage());

    await act(async () => {
      await result.current.handlers.sendRequest();
    });

    // The resolved URL is recorded for display/copy…
    const lastHistoryEntry = useHistoryStore.getState().history[0];
    expect(lastHistoryEntry?.resolvedUrl).toBe('https://example.com/anything');
    const lastConsoleEntry = useConsoleStore.getState().entries[0];
    expect(lastConsoleEntry?.resolvedUrl).toBe('https://example.com/anything');

    // …but request.url keeps the original template so reopening/replaying
    // this entry still targets whichever environment is active.
    expect(lastHistoryEntry?.request.url).toBe('{{baseUrl}}/anything');
    expect(lastConsoleEntry?.request.url).toBe('{{baseUrl}}/anything');
  });

  it('persists the resolved URL on a failed send too', async () => {
    vi.doMock('axios', () => {
      const post = vi.fn().mockRejectedValue(new Error('Network Error'));
      const mockAxios = Object.assign(vi.fn().mockRejectedValue(new Error('Network Error')), {
        post,
      });
      return { default: mockAxios, isAxiosError: () => false };
    });

    const { useEnvironmentStore } = await import('@/store/useEnvironmentStore');
    const { useRequestStore } = await import('@/store/useRequestStore');
    const { useHistoryStore } = await import('@/store/useHistoryStore');
    const { useConsoleStore } = await import('@/store/useConsoleStore');

    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env1',
          name: 'Env',
          variables: [{ id: 'v1', key: 'baseUrl', value: 'https://example.com', enabled: true }],
        },
      ],
      activeEnvironmentId: 'env1',
    });

    const httpRequest = {
      id: 'req-2',
      name: 'Templated request',
      type: 'http' as const,
      method: 'GET' as const,
      url: '{{baseUrl}}/anything',
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth: { type: 'none' as const },
    };

    useRequestStore.setState({
      tabs: [{ id: 'tab1', request: httpRequest, isDirty: false }],
      activeTabId: 'tab1',
      isLoading: false,
    });
    useHistoryStore.setState({ history: [] });
    useConsoleStore.setState({ entries: [] });

    const { useHttpRequestPage } = await import('../useHttpRequestPage');
    const { result } = renderHook(() => useHttpRequestPage());

    await act(async () => {
      await result.current.handlers.sendRequest();
    });

    // The resolved URL is recorded for display/copy…
    const lastHistoryEntry = useHistoryStore.getState().history[0];
    expect(lastHistoryEntry?.resolvedUrl).toBe('https://example.com/anything');
    const lastConsoleEntry = useConsoleStore.getState().entries[0];
    expect(lastConsoleEntry?.resolvedUrl).toBe('https://example.com/anything');

    // …but request.url keeps the original template so reopening/replaying
    // this entry still targets whichever environment is active.
    expect(lastHistoryEntry?.request.url).toBe('{{baseUrl}}/anything');
    expect(lastConsoleEntry?.request.url).toBe('{{baseUrl}}/anything');
  });

  it('web send goes through the Worker proxy, never direct browser HTTP (shared-executor convergence)', async () => {
    const axios = (await import('axios')).default as unknown as {
      (...args: unknown[]): unknown;
      post: ReturnType<typeof vi.fn>;
    };
    axios.post.mockClear();

    const { useEnvironmentStore } = await import('@/store/useEnvironmentStore');
    const { useRequestStore } = await import('@/store/useRequestStore');

    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env1',
          name: 'Env',
          variables: [{ id: 'v1', key: 'baseUrl', value: 'https://example.com', enabled: true }],
        },
      ],
      activeEnvironmentId: 'env1',
    });

    const httpRequest = {
      id: 'req-proxy',
      name: 'Proxy-routed request',
      type: 'http' as const,
      method: 'GET' as const,
      url: '{{baseUrl}}/anything',
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth: { type: 'none' as const },
    };

    useRequestStore.setState({
      tabs: [{ id: 'tab1', request: httpRequest, isDirty: false }],
      activeTabId: 'tab1',
      isLoading: false,
    });

    const { useHttpRequestPage } = await import('../useHttpRequestPage');
    const { result } = renderHook(() => useHttpRequestPage());

    await act(async () => {
      await result.current.handlers.sendRequest();
    });

    // Regression guard: the web interactive Send used to issue a direct
    // browser request to the upstream (dropping sign-at-wire auth, structured
    // bodies, redirect policy, and URL validation). It must POST the spec to
    // the Worker `/api/proxy` like every other execution path.
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [proxyUrl, spec] = axios.post.mock.calls[0]!;
    expect(String(proxyUrl)).toContain('/api/proxy');
    expect(spec).toMatchObject({ method: 'GET', url: 'https://example.com/anything' });
  });

  it('reopening a console entry still replays the template, not the resolved URL', async () => {
    const { useEnvironmentStore } = await import('@/store/useEnvironmentStore');
    const { useRequestStore } = await import('@/store/useRequestStore');
    const { useHistoryStore } = await import('@/store/useHistoryStore');
    const { useConsoleStore } = await import('@/store/useConsoleStore');
    const { entryToHttpRequest } = await import('@/store/useConsoleStore');

    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env1',
          name: 'Env',
          variables: [{ id: 'v1', key: 'baseUrl', value: 'https://example.com', enabled: true }],
        },
      ],
      activeEnvironmentId: 'env1',
    });

    const httpRequest = {
      id: 'req-3',
      name: 'Templated request',
      type: 'http' as const,
      method: 'GET' as const,
      url: '{{baseUrl}}/anything',
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth: { type: 'none' as const },
    };

    useRequestStore.setState({
      tabs: [{ id: 'tab1', request: httpRequest, isDirty: false }],
      activeTabId: 'tab1',
      isLoading: false,
    });
    useHistoryStore.setState({ history: [] });
    useConsoleStore.setState({ entries: [] });

    const { useHttpRequestPage } = await import('../useHttpRequestPage');
    const { result } = renderHook(() => useHttpRequestPage());

    await act(async () => {
      await result.current.handlers.sendRequest();
    });

    // Regression guard for the reported bug: replaying/reopening a console
    // entry must reconstruct the original `{{var}}` template, not the
    // resolved URL that happened to be active at send time — otherwise the
    // user can never resend against a different environment.
    const lastConsoleEntry = useConsoleStore.getState().entries[0];
    expect(lastConsoleEntry).toBeDefined();
    const replayed = entryToHttpRequest(lastConsoleEntry!);
    expect(replayed.url).toBe('{{baseUrl}}/anything');
  });
});
