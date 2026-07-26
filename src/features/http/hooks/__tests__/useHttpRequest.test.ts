import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as requestExecutorModule from '@/features/http/lib/requestExecutor';
import type { HttpRequest, Response, StreamEventLike } from '@/types';

const runnerMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

const executorMocks = vi.hoisted(() => ({
  executeStreamingRequest: vi.fn(),
}));

vi.mock('@/features/registry/useRequestRunner', () => ({
  useRequestRunner: () => ({ run: runnerMocks.run, abort: vi.fn() }),
}));

vi.mock('@/features/http/lib/requestExecutor', async (importOriginal) => ({
  ...(await importOriginal<typeof requestExecutorModule>()),
  executeStreamingRequest: executorMocks.executeStreamingRequest,
}));

vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => false,
}));

vi.mock('@/components/shared/AriaLiveAnnouncer', () => ({
  useRequestAnnouncements: () => ({
    announceRequestSent: vi.fn(),
    announceRequestComplete: vi.fn(),
    announceRequestFailed: vi.fn(),
  }),
}));

import { useRequestStore } from '@/store/useRequestStore';
import { useHttpRequest } from '../useHttpRequest';

function makeRequest(id: string, name: string, streaming = false): HttpRequest {
  return {
    id,
    name,
    type: 'http',
    method: 'GET',
    url: 'https://example.com',
    headers: streaming
      ? [{ id: 'accept', key: 'Accept', value: 'text/event-stream', enabled: true }]
      : [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
}

function makeResponse(requestId: string, body: string): Response {
  return {
    id: `response-${requestId}`,
    requestId,
    status: 200,
    statusText: 'OK',
    headers: {},
    body,
    size: body.length,
    time: 10,
    timestamp: Date.now(),
  };
}

function makeEvents(label: string): AsyncIterable<StreamEventLike> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEventLike> {
      yield { type: 'raw', payload: label };
    },
  };
}

describe('useHttpRequest request completion routing', () => {
  beforeEach(() => {
    runnerMocks.run.mockReset();
    executorMocks.executeStreamingRequest.mockReset();
  });

  it('writes a delayed buffered response to the tab that started the request', async () => {
    const originRequest = makeRequest('request-origin', 'Origin');
    const response = makeResponse(originRequest.id, 'origin response');
    let resolveRun: ((result: { response: Response; durationMs: number }) => void) | undefined;
    runnerMocks.run.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      })
    );
    useRequestStore.setState({
      tabs: [
        { id: 'tab-origin', request: originRequest, isDirty: false },
        { id: 'tab-other', request: makeRequest('request-other', 'Other'), isDirty: false },
      ],
      activeTabId: 'tab-origin',
      isLoading: false,
    });

    const { result } = renderHook(() => useHttpRequest());
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendRequest();
      useRequestStore.getState().switchTab('tab-other');
    });
    await act(async () => {
      resolveRun?.({ response, durationMs: 10 });
      await sendPromise;
    });

    const state = useRequestStore.getState();
    expect(state.tabs.find((tab) => tab.id === 'tab-origin')?.response).toEqual(response);
    expect(state.tabs.find((tab) => tab.id === 'tab-other')?.response).toBeUndefined();
  });

  it('drops a delayed streaming completion when its origin tab has closed', async () => {
    const originRequest = makeRequest('request-origin', 'Origin', true);
    const sentinelResponse = makeResponse('request-other', 'keep response');
    const sentinelScriptResult = {
      test: { success: true, logs: [], errors: [], variables: { keep: 'true' } },
    };
    const sentinelEvents = makeEvents('keep stream');
    const completedEvents = makeEvents('closed origin stream');
    let resolveStreaming:
      | ((result: requestExecutorModule.StreamingExecutionResult) => void)
      | undefined;
    executorMocks.executeStreamingRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveStreaming = resolve;
      })
    );
    useRequestStore.setState({
      tabs: [
        { id: 'tab-origin', request: originRequest, isDirty: false },
        {
          id: 'tab-other',
          request: makeRequest('request-other', 'Other'),
          isDirty: false,
          response: sentinelResponse,
          scriptResult: sentinelScriptResult,
          streamingEvents: sentinelEvents,
        },
      ],
      activeTabId: 'tab-origin',
      isLoading: false,
    });

    const { result } = renderHook(() => useHttpRequest());
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendRequest();
      useRequestStore.getState().closeTab('tab-origin');
    });
    await act(async () => {
      resolveStreaming?.({
        events: completedEvents,
        responseMeta: { status: 200, statusText: 'OK', headers: {} },
      });
      await sendPromise;
    });

    const state = useRequestStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe('tab-other');
    expect(state.tabs[0]?.response).toBe(sentinelResponse);
    expect(state.tabs[0]?.scriptResult).toBe(sentinelScriptResult);
    expect(state.tabs[0]?.streamingEvents).toBe(sentinelEvents);
  });
});
