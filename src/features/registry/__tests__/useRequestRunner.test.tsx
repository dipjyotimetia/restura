import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('useRequestRunner', () => {
  beforeEach(() => vi.resetModules());

  it('runs a registered protocol and resolves with response', async () => {
    const { protocolRegistry } = await import('../registry');
    const fakeRun = vi.fn().mockResolvedValue({
      status: 200,
      body: '',
      headers: {},
      size: 0,
      time: 0,
    });
    protocolRegistry.register({
      id: 'fake-runner-test',
      label: 'Fake',
      tabType: 'http',
      defaultRequest: () => ({}) as never,
      runRequest: fakeRun,
    });
    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    await act(async () => {
      await result.current.run(
        { id: 'r1', type: 'http', method: 'GET', url: 'https://example' } as never,
        'fake-runner-test'
      );
    });
    expect(fakeRun).toHaveBeenCalledTimes(1);
  });

  it('persists pm.environment writes from a non-HTTP protocol to the active environment', async () => {
    const { protocolRegistry } = await import('../registry');
    const { useEnvironmentStore } = await import('@/store/useEnvironmentStore');
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env-1',
          name: 'Dev',
          variables: [{ id: 'v1', key: 'stale', value: 'x', enabled: true }],
        },
      ],
      activeEnvironmentId: 'env-1',
    } as never);
    protocolRegistry.register({
      id: 'fake-grpc-env-test',
      label: 'Fake',
      tabType: 'grpc',
      defaultRequest: () => ({}) as never,
      runRequest: async (_req, ctx) => {
        ctx.onScriptResult?.({
          preRequest: {
            success: true,
            logs: [],
            errors: [],
            variables: {},
            environmentMutations: { nonce: 'n-1' },
          },
          test: {
            success: true,
            logs: [],
            errors: [],
            variables: {},
            environmentMutations: { user_id: '42', stale: null },
          },
        } as never);
        return { status: 0, statusText: 'OK', headers: {}, body: '', size: 0, time: 0 } as never;
      },
    });
    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    await act(async () => {
      await result.current.run({ id: 'g1', type: 'grpc' } as never, 'fake-grpc-env-test');
    });
    const vars = useEnvironmentStore.getState().environments[0]?.variables ?? [];
    expect(Object.fromEntries(vars.map((v) => [v.key, v.value]))).toEqual({
      nonce: 'n-1',
      user_id: '42',
    });
  });

  it('writes script env changes to the environment active at send time, not after a mid-request switch', async () => {
    const { protocolRegistry } = await import('../registry');
    const { useEnvironmentStore } = await import('@/store/useEnvironmentStore');
    useEnvironmentStore.setState({
      environments: [
        { id: 'env-a', name: 'A', variables: [] },
        { id: 'env-b', name: 'B', variables: [] },
      ],
      activeEnvironmentId: 'env-a',
    } as never);
    protocolRegistry.register({
      id: 'fake-env-switch-test',
      label: 'Fake',
      tabType: 'grpc',
      defaultRequest: () => ({}) as never,
      runRequest: async (_req, ctx) => {
        // The user switches environment while the request is in flight.
        useEnvironmentStore.setState({ activeEnvironmentId: 'env-b' } as never);
        ctx.onScriptResult?.({
          test: {
            success: true,
            logs: [],
            errors: [],
            variables: {},
            environmentMutations: { token: 't-1' },
          },
        } as never);
        return { status: 0, statusText: 'OK', headers: {}, body: '', size: 0, time: 0 } as never;
      },
    });
    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    await act(async () => {
      await result.current.run({ id: 'g1', type: 'grpc' } as never, 'fake-env-switch-test');
    });
    const byId = Object.fromEntries(
      useEnvironmentStore.getState().environments.map((e) => [e.id, e.variables.map((v) => v.key)])
    );
    expect(byId).toEqual({ 'env-a': ['token'], 'env-b': [] });
  });

  it('warns when a script write to a secret environment variable was skipped', async () => {
    const warning = vi.fn();
    vi.doMock('sonner', () => ({ toast: { warning } }));
    const { protocolRegistry } = await import('../registry');
    const { useEnvironmentStore } = await import('@/store/useEnvironmentStore');
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'env-1',
          name: 'Dev',
          variables: [
            {
              id: 'v1',
              key: 'apiKey',
              value: '',
              enabled: true,
              secretRef: { kind: 'handle', id: 'h' },
            },
          ],
        },
      ],
      activeEnvironmentId: 'env-1',
    } as never);
    protocolRegistry.register({
      id: 'fake-secret-skip-test',
      label: 'Fake',
      tabType: 'grpc',
      defaultRequest: () => ({}) as never,
      runRequest: async (_req, ctx) => {
        ctx.onScriptResult?.({
          test: {
            success: true,
            logs: [],
            errors: [],
            variables: {},
            environmentMutations: { apiKey: 'leaked' },
          },
        } as never);
        return { status: 0, statusText: 'OK', headers: {}, body: '', size: 0, time: 0 } as never;
      },
    });
    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    await act(async () => {
      await result.current.run({ id: 'g1', type: 'grpc' } as never, 'fake-secret-skip-test');
    });
    vi.doUnmock('sonner');
    expect(warning).toHaveBeenCalledWith(
      'Script did not change secret environment variable: apiKey'
    );
  });

  it('throws when protocol id is unknown', async () => {
    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    await expect(result.current.run({ id: 'r2', type: 'http' } as never, 'nope')).rejects.toThrow(
      /unknown protocol/i
    );
  });

  it('abort() cancels an in-flight request via AbortSignal', async () => {
    const { protocolRegistry } = await import('../registry');
    const aborts: string[] = [];
    protocolRegistry.register({
      id: 'fake-abort-test',
      label: 'Fake',
      tabType: 'http',
      defaultRequest: () => ({}) as never,
      runRequest: async (_req, ctx) => {
        return new Promise((_, reject) => {
          ctx.signal.addEventListener('abort', () => {
            aborts.push('aborted');
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    });
    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    let runPromise: Promise<unknown> | undefined;
    act(() => {
      runPromise = result.current.run({ id: 'r' } as never, 'fake-abort-test');
    });
    act(() => result.current.abort());
    await expect(runPromise!).rejects.toThrow();
    expect(aborts).toEqual(['aborted']);
  });

  it('forwards script results from ctx.onScriptResult to the active tab and RunResult', async () => {
    const { protocolRegistry } = await import('../registry');
    const { useRequestStore } = await import('@/store/useRequestStore');

    // Capture the order in which the protocol callbacks fire so we can
    // assert the pipeline shape: scripts are emitted by the protocol
    // BEFORE the response resolves (matching the inline pipeline that
    // useHttpRequest used to drive directly).
    const callOrder: string[] = [];

    protocolRegistry.register({
      id: 'fake-scripts-test',
      label: 'Fake',
      tabType: 'http',
      defaultRequest: () => ({}) as never,
      runRequest: async (_req, ctx) => {
        callOrder.push('protocol-start');
        ctx.onScriptResult?.({
          preRequest: {
            success: true,
            logs: [{ type: 'log', message: 'pre ran', timestamp: 1 }],
            errors: [],
            variables: { token: 'abc' },
          },
          test: {
            success: true,
            logs: [{ type: 'info', message: 'test ran', timestamp: 2 }],
            errors: [],
            variables: {},
            tests: [{ name: 'status is 200', passed: true }],
          },
        });
        callOrder.push('protocol-resolved');
        return {
          id: 'resp-1',
          requestId: 'req-1',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 0,
          timestamp: Date.now(),
        };
      },
    });

    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());

    let runResult: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      runResult = await result.current.run(
        { id: 'req-1', type: 'http' } as never,
        'fake-scripts-test'
      );
    });

    // Protocol fired the scripts callback before resolving the response.
    expect(callOrder).toEqual(['protocol-start', 'protocol-resolved']);

    // RunResult exposes the script result so callers can react to it
    // without subscribing to the store.
    expect(runResult?.scriptResult?.preRequest?.logs?.[0]?.message).toBe('pre ran');
    expect(runResult?.scriptResult?.test?.tests?.[0]?.passed).toBe(true);

    // And the active tab was updated so the Console panel renders.
    const activeTab = useRequestStore.getState().getActiveTab();
    expect(activeTab?.scriptResult?.preRequest?.variables?.token).toBe('abc');
    expect(activeTab?.scriptResult?.test?.tests?.[0]?.name).toBe('status is 200');
  });

  it('forwards a delayed script result to the tab that started the run', async () => {
    const { protocolRegistry } = await import('../registry');
    const { useRequestStore } = await import('@/store/useRequestStore');
    let releaseProtocol: (() => void) | undefined;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseProtocol = resolve;
    });

    protocolRegistry.register({
      id: 'fake-origin-tab-scripts-test',
      label: 'Fake',
      tabType: 'http',
      defaultRequest: () => ({}) as never,
      runRequest: async (_req, ctx) => {
        await waitForRelease;
        ctx.onScriptResult?.({
          preRequest: {
            success: true,
            logs: [],
            errors: [],
            variables: { destination: 'origin' },
          },
        });
        return {
          id: 'resp-origin',
          requestId: 'req-origin',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 0,
          timestamp: Date.now(),
        };
      },
    });

    const originRequest = { id: 'req-origin', name: 'Origin', type: 'http' } as never;
    const otherRequest = { id: 'req-other', name: 'Other', type: 'http' } as never;
    useRequestStore.setState({
      tabs: [
        { id: 'tab-origin', request: originRequest, isDirty: false },
        { id: 'tab-other', request: otherRequest, isDirty: false },
      ],
      activeTabId: 'tab-origin',
      isLoading: false,
    });

    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    let runPromise: ReturnType<typeof result.current.run> | undefined;
    act(() => {
      runPromise = result.current.run(originRequest, 'fake-origin-tab-scripts-test');
    });
    act(() => {
      useRequestStore.getState().switchTab('tab-other');
      releaseProtocol?.();
    });
    await act(async () => {
      await runPromise;
    });

    const state = useRequestStore.getState();
    expect(state.tabs.find((tab) => tab.id === 'tab-origin')?.scriptResult).toMatchObject({
      preRequest: { variables: { destination: 'origin' } },
    });
    expect(state.tabs.find((tab) => tab.id === 'tab-other')?.scriptResult).toBeUndefined();
  });

  it('drops a delayed script result when the tab that started the run has closed', async () => {
    const { protocolRegistry } = await import('../registry');
    const { useRequestStore } = await import('@/store/useRequestStore');
    let releaseProtocol: (() => void) | undefined;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseProtocol = resolve;
    });

    protocolRegistry.register({
      id: 'fake-closed-origin-tab-scripts-test',
      label: 'Fake',
      tabType: 'http',
      defaultRequest: () => ({}) as never,
      runRequest: async (_req, ctx) => {
        await waitForRelease;
        ctx.onScriptResult?.({
          test: { success: true, logs: [], errors: [], variables: {} },
        });
        return {
          id: 'resp-closed',
          requestId: 'req-closed',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 0,
          timestamp: Date.now(),
        };
      },
    });

    const originRequest = { id: 'req-closed', name: 'Closing', type: 'http' } as never;
    const otherRequest = { id: 'req-stays', name: 'Stays', type: 'http' } as never;
    useRequestStore.setState({
      tabs: [
        { id: 'tab-closing', request: originRequest, isDirty: false },
        { id: 'tab-stays', request: otherRequest, isDirty: false },
      ],
      activeTabId: 'tab-closing',
      isLoading: false,
    });

    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    let runPromise: ReturnType<typeof result.current.run> | undefined;
    act(() => {
      runPromise = result.current.run(originRequest, 'fake-closed-origin-tab-scripts-test');
    });
    act(() => {
      useRequestStore.getState().closeTab('tab-closing');
      releaseProtocol?.();
    });
    await act(async () => {
      await runPromise;
    });

    const state = useRequestStore.getState();
    expect(state.activeTabId).toBe('tab-stays');
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.scriptResult).toBeUndefined();
  });

  it('omits scriptResult on RunResult when the protocol never calls onScriptResult', async () => {
    const { protocolRegistry } = await import('../registry');
    protocolRegistry.register({
      id: 'fake-no-scripts-test',
      label: 'Fake',
      tabType: 'http',
      defaultRequest: () => ({}) as never,
      runRequest: async () => ({
        id: 'r',
        requestId: 'r',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        size: 0,
        time: 0,
        timestamp: Date.now(),
      }),
    });
    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    let runResult: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      runResult = await result.current.run({ id: 'r' } as never, 'fake-no-scripts-test');
    });
    // No scriptResult key when the protocol opts out — keeps the surface
    // minimal for protocols without a script pipeline (e.g. WebSocket).
    expect(runResult?.scriptResult).toBeUndefined();
  });

  describe('single-send auth inheritance', () => {
    const okResponse = () => ({
      id: 'r',
      requestId: 'r',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '',
      size: 0,
      time: 0,
      timestamp: Date.now(),
    });

    const baseRequest = (id: string, auth: unknown) => ({
      id,
      name: 'R',
      type: 'http',
      method: 'GET',
      url: 'https://example.com',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth,
    });

    it('applies folder/collection auth when the request auth is none', async () => {
      const { protocolRegistry } = await import('../registry');
      const { useCollectionStore } = await import('@/store/useCollectionStore');
      useCollectionStore.setState({
        collections: [
          {
            id: 'c1',
            name: 'API',
            auth: { type: 'bearer', bearer: { token: 'inherited-token' } },
            items: [
              {
                id: 'i1',
                name: 'R',
                type: 'request',
                request: baseRequest('req-inherit', { type: 'none' }) as never,
              },
            ],
          },
        ],
      });
      const seen: unknown[] = [];
      protocolRegistry.register({
        id: 'fake-inherit-test',
        label: 'Fake',
        tabType: 'http',
        defaultRequest: () => ({}) as never,
        runRequest: async (req) => {
          seen.push(req);
          return okResponse();
        },
      });
      const { useRequestRunner } = await import('../useRequestRunner');
      const { result } = renderHook(() => useRequestRunner());
      await act(async () => {
        await result.current.run(
          baseRequest('req-inherit', { type: 'none' }) as never,
          'fake-inherit-test'
        );
      });
      const sent = seen[0] as { auth: { type: string; bearer?: { token: string } } };
      expect(sent.auth.type).toBe('bearer');
      expect(sent.auth.bearer?.token).toBe('inherited-token');
    });

    it('leaves a request with its own auth untouched', async () => {
      const { protocolRegistry } = await import('../registry');
      const { useCollectionStore } = await import('@/store/useCollectionStore');
      useCollectionStore.setState({
        collections: [
          {
            id: 'c1',
            name: 'API',
            auth: { type: 'bearer', bearer: { token: 'inherited-token' } },
            items: [
              {
                id: 'i1',
                name: 'R',
                type: 'request',
                request: baseRequest('req-own', { type: 'none' }) as never,
              },
            ],
          },
        ],
      });
      const seen: unknown[] = [];
      protocolRegistry.register({
        id: 'fake-own-auth-test',
        label: 'Fake',
        tabType: 'http',
        defaultRequest: () => ({}) as never,
        runRequest: async (req) => {
          seen.push(req);
          return okResponse();
        },
      });
      const { useRequestRunner } = await import('../useRequestRunner');
      const { result } = renderHook(() => useRequestRunner());
      const ownAuth = { type: 'bearer', bearer: { token: 'my-own' } };
      await act(async () => {
        await result.current.run(baseRequest('req-own', ownAuth) as never, 'fake-own-auth-test');
      });
      const sent = seen[0] as { auth: { bearer?: { token: string } } };
      expect(sent.auth.bearer?.token).toBe('my-own');
    });
  });

  describe('refreshed auth', () => {
    const okResponse = () => ({
      id: 'r',
      requestId: 'r',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '',
      size: 0,
      time: 0,
      timestamp: Date.now(),
    });
    const refreshed = { type: 'oauth2', oauth2: { accessToken: 'fresh' } };
    const requestWith = (id: string, auth: unknown) =>
      ({
        id,
        name: 'R',
        type: 'http',
        method: 'GET',
        url: 'https://example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth,
      }) as never;

    async function runWithRefresh(protocolId: string, request: never, tabId: string) {
      const { protocolRegistry } = await import('../registry');
      const { useRequestStore } = await import('@/store/useRequestStore');
      protocolRegistry.register({
        id: protocolId,
        label: 'Fake',
        tabType: 'http',
        defaultRequest: () => ({}) as never,
        runRequest: async (_req, ctx) => {
          ctx.onAuthRefreshed?.(refreshed as never);
          return okResponse();
        },
      });
      useRequestStore.setState({
        tabs: [{ id: tabId, request, isDirty: false }],
        activeTabId: tabId,
        isLoading: false,
      });
      const { useRequestRunner } = await import('../useRequestRunner');
      const { result } = renderHook(() => useRequestRunner());
      await act(async () => {
        await result.current.run(request, protocolId);
      });
      return useRequestStore.getState().tabs.find((t) => t.id === tabId);
    }

    it('persists a refreshed OAuth2 token onto the originating tab when the request owns its auth', async () => {
      const tab = await runWithRefresh(
        'fake-refresh-own',
        requestWith('req-own', { type: 'oauth2', oauth2: { accessToken: 'stale' } }),
        'tab-own'
      );
      expect((tab?.request as { auth: unknown }).auth).toEqual(refreshed);
    });

    it('does not materialise a refreshed token onto a request whose auth is inherited', async () => {
      const tab = await runWithRefresh(
        'fake-refresh-inherited',
        requestWith('req-inherited', { type: 'none' }),
        'tab-inherited'
      );
      expect((tab?.request as { auth: unknown }).auth).toEqual({ type: 'none' });
    });
  });

  it('hands the active Secret references to the protocol as ctx.secretVariables', async () => {
    const secretVariables = { apiKey: { kind: 'handle', id: 'handle-1' } };
    vi.doMock('@/lib/shared/activeRequestScopes', () => ({
      buildActiveRequestVariableResolution: () => ({ values: { host: 'x' }, secretVariables }),
    }));
    const { protocolRegistry } = await import('../registry');
    let seen: { variables?: unknown; secretVariables?: unknown } = {};
    protocolRegistry.register({
      id: 'fake-secret-vars-test',
      label: 'Fake',
      tabType: 'http',
      defaultRequest: () => ({}) as never,
      runRequest: async (_req, ctx) => {
        seen = { variables: ctx.variables, secretVariables: ctx.secretVariables };
        return {
          id: 'r',
          requestId: 'r',
          status: 200,
          statusText: 'OK',
          headers: {},
          body: '',
          size: 0,
          time: 0,
          timestamp: Date.now(),
        };
      },
    });
    const { useRequestRunner } = await import('../useRequestRunner');
    const { result } = renderHook(() => useRequestRunner());
    await act(async () => {
      await result.current.run(
        { id: 'r1', type: 'http', method: 'GET', url: 'https://x' } as never,
        'fake-secret-vars-test'
      );
    });
    expect(seen).toEqual({ variables: { host: 'x' }, secretVariables });
    vi.doUnmock('@/lib/shared/activeRequestScopes');
  });
  describe('collection variables for non-HTTP single sends', () => {
    async function seedCollectionTab() {
      const { useCollectionStore } = await import('@/store/useCollectionStore');
      const { useRequestStore } = await import('@/store/useRequestStore');
      useCollectionStore.setState({
        collections: [
          {
            id: 'col-1',
            name: 'API',
            variables: [
              { id: 'cv1', key: 'base', value: 'b1', enabled: true },
              { id: 'cv2', key: 'gone', value: 'g', enabled: true },
            ],
            items: [{ id: 'item-1', name: 'G', type: 'request', request: { id: 'g1' } as never }],
          },
        ],
      } as never);
      useRequestStore.setState({
        tabs: [
          {
            id: 'tab-g',
            request: { id: 'g1', type: 'grpc' } as never,
            isDirty: false,
            savedRequestId: 'item-1',
          },
        ],
        activeTabId: 'tab-g',
      } as never);
      return useCollectionStore;
    }

    it('hands the owning collection variables to the protocol and persists script writes', async () => {
      const collectionStore = await seedCollectionTab();
      const { protocolRegistry } = await import('../registry');
      let seenOptions: Record<string, unknown> | undefined;
      protocolRegistry.register({
        id: 'fake-collection-vars-test',
        label: 'Fake',
        tabType: 'grpc',
        defaultRequest: () => ({}) as never,
        runRequest: async (_req, ctx) => {
          seenOptions = ctx.protocolOptions;
          ctx.onScriptResult?.({
            preRequest: {
              success: true,
              logs: [],
              errors: [],
              variables: {},
              collectionMutations: { token: 'abc' },
            },
            test: {
              success: true,
              logs: [],
              errors: [],
              variables: {},
              collectionMutations: { gone: null },
            },
          } as never);
          return { status: 0, statusText: 'OK', headers: {}, body: '', size: 0, time: 0 } as never;
        },
      });
      const { useRequestRunner } = await import('../useRequestRunner');
      const { result } = renderHook(() => useRequestRunner());
      await act(async () => {
        await result.current.run({ id: 'g1', type: 'grpc' } as never, 'fake-collection-vars-test', {
          protocolOptions: { protoContent: 'x' },
        });
      });
      expect(seenOptions).toMatchObject({
        protoContent: 'x',
        collectionVars: { base: 'b1', gone: 'g' },
      });
      const vars = collectionStore.getState().collections[0]?.variables ?? [];
      expect(Object.fromEntries(vars.map((v) => [v.key, v.value]))).toEqual({
        base: 'b1',
        token: 'abc',
      });
    });

    it('skips history and script persistence when the run was aborted before the response returned', async () => {
      const collectionStore = await seedCollectionTab();
      const { useHistoryStore } = await import('@/store/useHistoryStore');
      const historyBefore = useHistoryStore.getState().history.length;
      const { protocolRegistry } = await import('../registry');
      let abortRun: (() => void) | undefined;
      protocolRegistry.register({
        id: 'fake-late-abort-test',
        label: 'Fake',
        tabType: 'grpc',
        defaultRequest: () => ({}) as never,
        runRequest: async (_req, ctx) => {
          // A transport that ignores the signal resolves after the user cancelled.
          abortRun?.();
          ctx.onScriptResult?.({
            test: {
              success: true,
              logs: [],
              errors: [],
              variables: {},
              collectionMutations: { token: 'late' },
            },
          } as never);
          return { status: 0, statusText: 'OK', headers: {}, body: '', size: 0, time: 0 } as never;
        },
      });
      const { useRequestRunner } = await import('../useRequestRunner');
      const { result } = renderHook(() => useRequestRunner());
      abortRun = () => result.current.abort();
      let outcome: unknown;
      await act(async () => {
        outcome = await result.current
          .run({ id: 'g1', type: 'grpc' } as never, 'fake-late-abort-test')
          .catch((e: unknown) => e);
      });
      expect((outcome as Error).name).toBe('AbortError');
      expect(useHistoryStore.getState().history.length).toBe(historyBefore);
      const vars = collectionStore.getState().collections[0]?.variables ?? [];
      expect(vars.map((v) => v.key)).toEqual(['base', 'gone']);
    });
  });
});
