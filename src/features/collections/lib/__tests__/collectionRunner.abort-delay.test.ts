import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@/features/registry/types';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { Response as ApiResponse, Collection, HttpRequest } from '@/types';
import type { RunnableRequest } from '../flattenRunnables';

let onCall: (index: number) => void = () => {};
let callIndex = 0;

const runRequestMock = vi.fn(async (_req: unknown, _ctx: RunContext): Promise<ApiResponse> => {
  onCall(callIndex++);
  return {
    id: 'r',
    requestId: 'req',
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '',
    size: 0,
    time: 1,
    timestamp: Date.now(),
  };
});

vi.mock('@/features/registry/registry', () => ({
  protocolRegistry: {
    get: (id: string) =>
      id === 'http'
        ? { id: 'http', runRequest: runRequestMock, injectVariables: (r: unknown) => r }
        : undefined,
  },
}));

import { runCollection } from '../collectionRunner';

function runnable(id: string): RunnableRequest {
  const request: HttpRequest = {
    id,
    name: id,
    type: 'http',
    method: 'GET',
    url: 'https://example.test',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
  return { itemId: id, name: id, request };
}

const collection: Collection = { id: 'c', name: 'C', items: [] };

beforeEach(() => {
  callIndex = 0;
  onCall = () => {};
  runRequestMock.mockClear();
  useCollectionStore.setState({ collections: [collection], activeCollectionId: null });
});

const base = (delayMs: number) => ({
  collection,
  scopeName: 'C',
  runnables: [runnable('1'), runnable('2')],
  baseVars: {},
  iterations: 1,
  dataRows: [],
  delayMs,
  stopOnFailure: false,
});

describe('runCollection abort + delay edge cases', () => {
  it('is completed, not aborted, when Stop is pressed during the final request', async () => {
    const ac = new AbortController();
    onCall = (i) => {
      if (i === 1) ac.abort();
    };
    const result = await runCollection(base(0), () => {}, ac.signal);
    expect(result.requests).toHaveLength(2);
    expect(result.outcome).toBe('completed');
  });

  it('is aborted when Stop prevented requests from running', async () => {
    const ac = new AbortController();
    onCall = (i) => {
      if (i === 0) ac.abort();
    };
    const result = await runCollection(base(0), () => {}, ac.signal);
    expect(result.requests).toHaveLength(1);
    expect(result.outcome).toBe('aborted');
  });

  it('does not wait after the final request of the final iteration', async () => {
    const started = Date.now();
    await runCollection(base(400), () => {}, new AbortController().signal);
    const elapsed = Date.now() - started;
    // One inter-request delay (400ms) only, not two.
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(700);
  });
});
