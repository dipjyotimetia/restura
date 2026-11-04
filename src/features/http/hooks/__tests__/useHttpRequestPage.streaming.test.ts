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
      executor.executeStreamingRequest.mockResolvedValue({
        events: stream,
        responseMeta: { status: 200, statusText: 'OK', headers: {} },
      });
      setup(accept);
      await send();

      expect(executor.executeRequest).not.toHaveBeenCalled();
      expect(executor.executeStreamingRequest).toHaveBeenCalledTimes(1);
      const tab = useRequestStore.getState().tabs[0];
      expect(tab?.streamingEvents).toBe(stream);
      expect(tab?.response ?? null).toBeNull();
      expect(useRequestStore.getState().isLoading).toBe(false);
    }
  );

  it('a later buffered send clears the previous stream', async () => {
    executor.executeStreamingRequest.mockResolvedValue({
      events: events(),
      responseMeta: { status: 200, statusText: 'OK', headers: {} },
    });
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
});
