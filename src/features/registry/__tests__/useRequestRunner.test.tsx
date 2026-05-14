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
    await expect(
      result.current.run({ id: 'r2', type: 'http' } as never, 'nope')
    ).rejects.toThrow(/unknown protocol/i);
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
});
