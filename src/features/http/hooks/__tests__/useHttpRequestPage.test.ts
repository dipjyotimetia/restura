import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/shared/platform', () => ({ isElectron: () => false }));

vi.mock('axios', () => {
  const mockAxios = vi.fn().mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: { ok: true },
    config: { headers: {}, url: undefined },
  });
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
      const mockAxios = vi.fn().mockRejectedValue(new Error('Network Error'));
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
