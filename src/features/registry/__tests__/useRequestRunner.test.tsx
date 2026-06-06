import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
