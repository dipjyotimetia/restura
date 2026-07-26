import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as requestExecutorModule from '@/features/http/lib/requestExecutor';
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

  it('writes a delayed response and script result only to the tab that sent the request', async () => {
    let resolveExecution:
      | ((value: requestExecutorModule.RequestExecutionResult) => void)
      | undefined;
    const execution = new Promise<requestExecutorModule.RequestExecutionResult>((resolve) => {
      resolveExecution = resolve;
    });
    vi.doMock('@/features/http/lib/requestExecutor', async (importOriginal) => ({
      ...(await importOriginal<typeof requestExecutorModule>()),
      executeRequest: vi.fn(() => execution),
    }));

    const { useRequestStore } = await import('@/store/useRequestStore');
    const originRequest = {
      id: 'req-origin',
      name: 'Origin',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://origin.example',
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth: {
        type: 'oauth2' as const,
        oauth2: { accessToken: 'expired', refreshToken: 'refresh-token' },
      },
    };
    const otherRequest = { ...originRequest, id: 'req-other', name: 'Other' };
    useRequestStore.setState({
      tabs: [
        { id: 'tab-origin', request: originRequest, isDirty: false },
        { id: 'tab-other', request: otherRequest, isDirty: false },
      ],
      activeTabId: 'tab-origin',
      isLoading: false,
    });

    const response = {
      id: 'resp-origin',
      requestId: originRequest.id,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: 'origin response',
      size: 15,
      time: 10,
      timestamp: Date.now(),
    };
    const scriptResult = {
      preRequest: {
        success: true,
        logs: [],
        errors: [],
        variables: { destination: 'origin' },
      },
    };

    const { useHttpRequestPage } = await import('../useHttpRequestPage');
    const { result } = renderHook(() => useHttpRequestPage());
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.handlers.sendRequest();
      useRequestStore.getState().switchTab('tab-other');
    });
    await act(async () => {
      resolveExecution?.({
        response,
        transportOk: true,
        sentHeaders: {},
        scriptResult,
        refreshedAuth: {
          type: 'oauth2',
          oauth2: { accessToken: 'refreshed', refreshToken: 'refresh-token' },
        },
      });
      await sendPromise;
    });

    const state = useRequestStore.getState();
    expect(state.activeTabId).toBe('tab-other');
    expect(state.tabs.find((tab) => tab.id === 'tab-origin')?.response).toEqual(response);
    expect(state.tabs.find((tab) => tab.id === 'tab-origin')?.scriptResult).toEqual(scriptResult);
    expect(
      (
        state.tabs.find((tab) => tab.id === 'tab-origin')?.request.auth as {
          oauth2?: { accessToken?: string };
        }
      ).oauth2?.accessToken
    ).toBe('refreshed');
    expect(state.tabs.find((tab) => tab.id === 'tab-other')?.response).toBeUndefined();
    expect(state.tabs.find((tab) => tab.id === 'tab-other')?.scriptResult).toBeUndefined();
    expect(
      (
        state.tabs.find((tab) => tab.id === 'tab-other')?.request.auth as {
          oauth2?: { accessToken?: string };
        }
      ).oauth2?.accessToken
    ).toBe('expired');
  });

  it('writes a delayed thrown error only to the tab that sent the request', async () => {
    let rejectExecution: ((reason: Error) => void) | undefined;
    const execution = new Promise<requestExecutorModule.RequestExecutionResult>(
      (_resolve, reject) => {
        rejectExecution = reject;
      }
    );
    vi.doMock('@/features/http/lib/requestExecutor', async (importOriginal) => ({
      ...(await importOriginal<typeof requestExecutorModule>()),
      executeRequest: vi.fn(() => execution),
    }));

    const { useRequestStore } = await import('@/store/useRequestStore');
    const originRequest = {
      id: 'req-error-origin',
      name: 'Error origin',
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://origin.example',
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth: { type: 'none' as const },
    };
    const otherRequest = { ...originRequest, id: 'req-error-other', name: 'Other' };
    useRequestStore.setState({
      tabs: [
        { id: 'tab-error-origin', request: originRequest, isDirty: false },
        { id: 'tab-error-other', request: otherRequest, isDirty: false },
      ],
      activeTabId: 'tab-error-origin',
      isLoading: false,
    });

    const { useHttpRequestPage } = await import('../useHttpRequestPage');
    const { result } = renderHook(() => useHttpRequestPage());
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.handlers.sendRequest();
      useRequestStore.getState().switchTab('tab-error-other');
    });
    await act(async () => {
      rejectExecution?.(new Error('delayed failure'));
      await sendPromise;
    });

    const state = useRequestStore.getState();
    expect(state.activeTabId).toBe('tab-error-other');
    expect(state.tabs.find((tab) => tab.id === 'tab-error-origin')?.response).toMatchObject({
      requestId: 'req-error-origin',
      status: 0,
      body: 'delayed failure',
    });
    expect(state.tabs.find((tab) => tab.id === 'tab-error-other')?.response).toBeUndefined();
  });
});
