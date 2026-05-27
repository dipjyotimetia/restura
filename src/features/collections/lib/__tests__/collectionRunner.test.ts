import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Collection, HttpRequest, Response as ApiResponse } from '@/types';
import type { RunContext, ProtocolScriptResult } from '@/features/registry/types';
import type { RunnableRequest } from '../flattenRunnables';

// --- Mock the protocol registry so we control runRequest per request ---------
type Behavior = {
  status?: number;
  throws?: string;
  tests?: Array<{ name: string; passed: boolean; error?: string }>;
  setVars?: Record<string, string>;
  scriptErrors?: string[];
};

const behaviors: Behavior[] = [];
const seenVariables: Array<Record<string, string>> = [];
let callIndex = 0;

const runRequestMock = vi.fn(async (_req: unknown, ctx: RunContext): Promise<ApiResponse> => {
  seenVariables.push({ ...ctx.variables });
  const b = behaviors[callIndex] ?? {};
  callIndex++;
  if (b.throws) throw new Error(b.throws);
  if (ctx.onScriptResult && (b.tests || b.setVars || b.scriptErrors)) {
    const result: ProtocolScriptResult = {
      test: {
        success: true,
        logs: [],
        errors: b.scriptErrors ?? [],
        variables: b.setVars ?? {},
        ...(b.tests ? { tests: b.tests } : {}),
      },
    };
    ctx.onScriptResult(result);
  }
  return {
    id: 'r',
    requestId: 'req',
    status: b.status ?? 200,
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
    get: (id: string) => {
      if (id === 'http') {
        return { id: 'http', runRequest: runRequestMock, injectVariables: (r: unknown) => r };
      }
      if (id === 'sse') {
        return { id: 'sse', runRequest: runRequestMock };
      }
      return undefined;
    },
  },
}));

// Import after mock is registered.
import { runCollection } from '../collectionRunner';

function httpReq(id: string, name: string): HttpRequest {
  return {
    id,
    name,
    type: 'http',
    method: 'GET',
    url: 'https://example.test',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
}

function runnable(id: string, name: string, type: 'http' | 'sse' = 'http'): RunnableRequest {
  const req = httpReq(id, name);
  return { itemId: id, name, request: type === 'sse' ? { ...req, type: 'sse' } as never : req };
}

const collection: Collection = { id: 'c', name: 'C', items: [] };
const noop = () => {};

beforeEach(() => {
  behaviors.length = 0;
  seenVariables.length = 0;
  callIndex = 0;
  runRequestMock.mockClear();
});

describe('runCollection', () => {
  it('carries pm.variables.set forward to later requests', async () => {
    behaviors.push({ setVars: { token: 'abc' } }, {});
    await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'first'), runnable('2', 'second')],
        baseVars: { base: '1' },
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    // Second request should see the var set by the first.
    expect(seenVariables[0]).toEqual({ base: '1' });
    expect(seenVariables[1]).toEqual({ base: '1', token: 'abc' });
  });

  it('aggregates pm.test assertions into pass/fail', async () => {
    behaviors.push(
      { tests: [{ name: 'ok', passed: true }] },
      { tests: [{ name: 'bad', passed: false, error: 'nope' }] }
    );
    const result = await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'pass'), runnable('2', 'fail')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    expect(result.requests[0]!.status).toBe('success');
    expect(result.requests[1]!.status).toBe('failed');
    expect(result.summary).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
  });

  it('skips unsupported (streaming) protocols with a reason', async () => {
    const result = await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'stream', 'sse')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    expect(result.requests[0]!.status).toBe('skipped');
    expect(result.requests[0]!.skippedReason).toMatch(/not supported/);
    expect(runRequestMock).not.toHaveBeenCalled();
  });

  it('halts on first failure when stopOnFailure is set', async () => {
    behaviors.push({ status: 500 }, { status: 200 });
    const result = await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'boom'), runnable('2', 'never')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: true,
      },
      noop,
      new AbortController().signal
    );
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.status).toBe('failed');
    expect(runRequestMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'a')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      ac.signal
    );
    expect(result.requests).toHaveLength(0);
    expect(runRequestMock).not.toHaveBeenCalled();
  });

  it('runs one iteration per data row, layering row vars over base', async () => {
    behaviors.push({}, {});
    await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'a')],
        baseVars: { base: 'x' },
        iterations: 5, // ignored when dataRows present
        dataRows: [{ id: '1' }, { id: '2' }],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    expect(seenVariables[0]).toEqual({ base: 'x', id: '1' });
    expect(seenVariables[1]).toEqual({ base: 'x', id: '2' });
  });
});
