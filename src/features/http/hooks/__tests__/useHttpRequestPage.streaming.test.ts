import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as requestExecutorModule from '@/features/http/lib/requestExecutor';
import type * as platformModule from '@/lib/shared/platform';
import type { HttpRequest, Response, StreamEventLike } from '@/types';

const platform = vi.hoisted(() => ({ electron: false }));
vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof platformModule>()),
  isElectron: () => platform.electron,
}));

const executor = vi.hoisted(() => ({
  executeStreamingRequest: vi.fn(),
  executeRequest: vi.fn(),
}));
vi.mock('@/features/http/lib/requestExecutor', async (importOriginal) => ({
  ...(await importOriginal<typeof requestExecutorModule>()),
  executeStreamingRequest: executor.executeStreamingRequest,
  executeRequest: executor.executeRequest,
}));

vi.mock('@/components/shared/AriaLiveAnnouncer', () => ({
  useRequestAnnouncements: () => ({
    announceRequestSent: vi.fn(),
    announceRequestComplete: vi.fn(),
    announceRequestFailed: vi.fn(),
  }),
}));

import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useHttpRequestPage } from '../useHttpRequestPage';

function makeRequest(accept: string | undefined): HttpRequest {
  return {
    id: 'req-1',
    name: 'Stream',
    type: 'http',
    method: 'GET',
    url: 'https://example.com/{{path}}',
    headers: accept ? [{ id: 'a', key: 'accept', value: accept, enabled: true }] : [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
}

function events(): AsyncIterable<StreamEventLike> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEventLike> {
      yield { type: 'raw', payload: '{"a":1}' };
    },
  };
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    response: { ...buffered, body: '{"a":1}\n{"a":2}\n' },
    envVars: {},
    sentUrl: 'https://example.com/feed',
    sentHeaders: { Accept: 'application/x-ndjson' },
    scriptResult: {},
    ...overrides,
  };
}

function streamResult(stream: AsyncIterable<StreamEventLike>, extra: Record<string, unknown> = {}) {
  return {
    events: stream,
    responseMeta: { status: 200, statusText: 'OK', headers: {} },
    sentUrl: 'https://example.com/feed',
    sentHeaders: {},
    finish: vi.fn(async () => completion()),
    ...extra,
  };
}

const buffered: Response = {
  id: 'r',
  requestId: 'req-1',
  status: 200,
  statusText: 'OK',
  headers: {},
  body: '{}',
  size: 2,
  time: 1,
  timestamp: 0,
};

function setup(accept: string | undefined) {
  useEnvironmentStore.setState({
    environments: [
      {
        id: 'env1',
        name: 'Env',
        variables: [
          { id: 'v1', key: 'path', value: 'feed', enabled: true },
          { id: 'v2', key: 'acc', value: 'application/x-ndjson', enabled: true },
        ],
      },
    ],
    activeEnvironmentId: 'env1',
  });
  useHistoryStore.setState({ history: [] });
  useRequestStore.setState({
    tabs: [{ id: 'tab1', request: makeRequest(accept), isDirty: false }],
    activeTabId: 'tab1',
    isLoading: false,
  });
}

async function send() {
  const { result } = renderHook(() => useHttpRequestPage());
  await act(async () => {
    await result.current.handlers.sendRequest();
  });
}

beforeEach(() => {
  platform.electron = false;
  executor.executeStreamingRequest.mockReset();
  executor.executeRequest.mockReset();
  executor.executeRequest.mockResolvedValue({
    response: buffered,
    transportOk: true,
    sentUrl: 'https://example.com/feed',
    sentHeaders: {},
  });
});

describe('useHttpRequestPage — streaming Accept', () => {
  it.each(['text/event-stream', 'application/x-ndjson', 'application/jsonl', '{{acc}}'])(
    'web: %s streams into the tab instead of the buffered path',
    async (accept) => {
      const stream = events();
      executor.executeStreamingRequest.mockResolvedValue(streamResult(stream));
      setup(accept);
      await send();

      expect(executor.executeRequest).not.toHaveBeenCalled();
      expect(executor.executeStreamingRequest).toHaveBeenCalledTimes(1);
      const tab = useRequestStore.getState().tabs[0];
      expect(tab?.streamingEvents).toBeDefined();
      expect(tab?.response ?? null).toBeNull();
      expect(useRequestStore.getState().isLoading).toBe(false);
    }
  );

  it('the stored stream replays in full for a second consumer (viewer remount / StrictMode)', async () => {
    async function* once() {
      yield { type: 'ndjson' as const, payload: { a: 1 } };
      yield { type: 'ndjson' as const, payload: { a: 2 } };
      yield { type: 'end' as const, bytesRead: 16, durationMs: 1 };
    }
    executor.executeStreamingRequest.mockResolvedValue(streamResult(once()));
    setup('application/x-ndjson');
    await send();
    const stored = useRequestStore.getState().tabs[0]?.streamingEvents;
    if (!stored) throw new Error('no stream stored');
    const read = async () => {
      const types: string[] = [];
      for await (const event of stored) types.push(event.type);
      return types;
    };
    // First consumer bails early, like an effect cleaned up mid-stream.
    for await (const _event of stored) break;
    expect(await read()).toEqual(['ndjson', 'ndjson', 'end']);
    expect(await read()).toEqual(['ndjson', 'ndjson', 'end']);
  });

  it('a later buffered send clears the previous stream', async () => {
    executor.executeStreamingRequest.mockResolvedValue(streamResult(events()));
    setup('text/event-stream');
    await send();
    useRequestStore.getState().updateRequest({ headers: [] });
    await send();
    const tab = useRequestStore.getState().tabs[0];
    expect(tab?.streamingEvents).toBeUndefined();
    expect(tab?.response).toBe(buffered);
  });

  it('desktop keeps the buffered path (no IPC streaming channel)', async () => {
    platform.electron = true;
    setup('text/event-stream');
    await send();
    expect(executor.executeStreamingRequest).not.toHaveBeenCalled();
    expect(executor.executeRequest).toHaveBeenCalledTimes(1);
  });

  it('when the stream ends: test results land on the tab, a history entry is written, script writes persist', async () => {
    async function* stream() {
      yield { type: 'ndjson' as const, payload: { a: 1 } };
      yield { type: 'ndjson' as const, payload: { a: 2 } };
      yield { type: 'end' as const, bytesRead: 16, durationMs: 5 };
    }
    const test = {
      success: true,
      logs: [{ type: 'log' as const, message: 'hi', timestamp: 0 }],
      errors: [],
      tests: [{ name: 'has events', passed: true }],
    };
    const result = streamResult(stream(), {
      finish: vi.fn(async () =>
        completion({ scriptResult: { test }, environmentMutations: { token: 't-1' } })
      ),
    });
    executor.executeStreamingRequest.mockResolvedValue(result);
    setup('application/x-ndjson');
    await send();

    expect(result.finish).toHaveBeenCalledWith({ type: 'end', bytesRead: 16, durationMs: 5 });
    const tab = useRequestStore.getState().tabs[0];
    expect(tab?.scriptResult?.test?.tests).toEqual([{ name: 'has events', passed: true }]);
    expect(tab?.streamingEvents).toBeDefined();
    const history = useHistoryStore.getState().history;
    expect(history).toHaveLength(1);
    expect(history[0]?.response?.body).toBe('{"a":1}\n{"a":2}\n');
    expect(history[0]?.resolvedUrl).toBe('https://example.com/feed');
    const vars = useEnvironmentStore.getState().environments[0]?.variables ?? [];
    expect(vars.find((v) => v.key === 'token')?.value).toBe('t-1');
    expect(useRequestStore.getState().isLoading).toBe(false);
  });

  it('cancel mid-stream: no test script, no history entry', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* stream() {
      yield { type: 'ndjson' as const, payload: { a: 1 } };
      await gate;
      yield { type: 'error' as const, error: 'aborted', bytesRead: 8 };
    }
    const result = streamResult(stream());
    executor.executeStreamingRequest.mockResolvedValue(result);
    setup('application/x-ndjson');
    const { result: hook } = renderHook(() => useHttpRequestPage());
    let sending!: Promise<void>;
    act(() => {
      sending = hook.current.handlers.sendRequest();
    });
    await vi.waitFor(() =>
      expect(useRequestStore.getState().tabs[0]?.streamingEvents).toBeDefined()
    );
    // Still in flight while the stream runs: Send is the Cancel button.
    expect(useRequestStore.getState().isLoading).toBe(true);
    act(() => hook.current.handlers.cancelRequest());
    release();
    await act(async () => {
      await sending;
    });

    expect(result.finish).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().history).toHaveLength(0);
    expect(useRequestStore.getState().tabs[0]?.scriptResult ?? null).toBeNull();
    expect(useRequestStore.getState().isLoading).toBe(false);
  });

  it('a skipped request (pm.execution.skipRequest) streams nothing and records no history', async () => {
    const preRequest = { success: true, logs: [], errors: [], execution: { skipRequested: true } };
    const result = streamResult((async function* () {})(), {
      skipped: true,
      scriptResult: { preRequest },
      finish: vi.fn(async () => completion({ scriptResult: { preRequest } })),
    });
    executor.executeStreamingRequest.mockResolvedValue(result);
    setup('application/x-ndjson');
    await send();

    const tab = useRequestStore.getState().tabs[0];
    expect(tab?.streamingEvents).toBeUndefined();
    expect(tab?.scriptResult?.preRequest).toEqual(preRequest);
    expect(useHistoryStore.getState().history).toHaveLength(0);
  });
});
