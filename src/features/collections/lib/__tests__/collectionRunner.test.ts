import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolScriptResult, RunContext } from '@/features/registry/types';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { Response as ApiResponse, Collection, HttpRequest } from '@/types';
import type { RunnableRequest } from '../flattenRunnables';

// --- Mock the protocol registry so we control runRequest per request ---------
type Behavior = {
  status?: number;
  throws?: string;
  tests?: Array<{ name: string; passed: boolean; error?: string }>;
  setVars?: Record<string, string>;
  scriptErrors?: string[];
  collectionMutations?: Record<string, string | null>;
};

const behaviors: Behavior[] = [];
const seenVariables: Array<Record<string, string>> = [];
const seenCollectionVars: Array<Record<string, string> | undefined> = [];
const injectVariablesMock = vi.fn((r: unknown) => r);
let callIndex = 0;

const runRequestMock = vi.fn(async (_req: unknown, ctx: RunContext): Promise<ApiResponse> => {
  seenVariables.push({ ...ctx.variables });
  seenCollectionVars.push(
    (ctx.protocolOptions as { collectionVars?: Record<string, string> } | undefined)?.collectionVars
  );
  const b = behaviors[callIndex] ?? {};
  callIndex++;
  if (b.throws) throw new Error(b.throws);
  if (ctx.onScriptResult && (b.tests || b.setVars || b.scriptErrors || b.collectionMutations)) {
    const result: ProtocolScriptResult = {
      test: {
        success: true,
        logs: [],
        errors: b.scriptErrors ?? [],
        variables: b.setVars ?? {},
        ...(b.tests ? { tests: b.tests } : {}),
        ...(b.collectionMutations ? { collectionMutations: b.collectionMutations } : {}),
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
        return { id: 'http', runRequest: runRequestMock, injectVariables: injectVariablesMock };
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
  return { itemId: id, name, request: type === 'sse' ? ({ ...req, type: 'sse' } as never) : req };
}

const collection: Collection = { id: 'c', name: 'C', items: [] };
const noop = () => {};

beforeEach(() => {
  behaviors.length = 0;
  seenVariables.length = 0;
  seenCollectionVars.length = 0;
  callIndex = 0;
  runRequestMock.mockClear();
  injectVariablesMock.mockClear();
  useCollectionStore.setState({ collections: [collection], activeCollectionId: null });
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
    expect(result.outcome).toBe('failed');
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

  it('threads collection.variables into ctx.protocolOptions.collectionVars', async () => {
    useCollectionStore.setState({
      collections: [
        { ...collection, variables: [{ id: 'v', key: 'apiVersion', value: 'v1', enabled: true }] },
      ],
      activeCollectionId: null,
    });
    behaviors.push({});
    await runCollection(
      {
        collection: useCollectionStore.getState().collections[0]!,
        scopeName: 'C',
        runnables: [runnable('1', 'a')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    expect(seenCollectionVars[0]).toEqual({ apiVersion: 'v1' });
  });

  it('persists pm.collectionVariables mutations and carries them forward within the run', async () => {
    behaviors.push({ collectionMutations: { token: 'abc123' } }, {});
    await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'first'), runnable('2', 'second')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    // Second request in the same run sees the mutation from the first.
    expect(seenCollectionVars[1]).toEqual({ token: 'abc123' });
    expect(seenVariables[1]).toEqual({ token: 'abc123' });
    // And it's written back to the persisted collection.
    const persisted = useCollectionStore.getState().getCollectionById(collection.id);
    expect(persisted?.variables).toEqual([
      { id: expect.any(String), key: 'token', value: 'abc123', enabled: true },
    ]);
  });

  it('keeps iteration data above collection mutations for later requests', async () => {
    behaviors.push({ collectionMutations: { token: 'collection-value' } }, {});
    await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'first'), runnable('2', 'second')],
        baseVars: {},
        iterations: 1,
        dataRows: [{ token: 'row-value' }],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    expect(seenVariables[1]?.token).toBe('row-value');
    expect(seenCollectionVars[1]?.token).toBe('collection-value');
  });

  it('leaves substitution to the protocol so pre-request scripts run first', async () => {
    behaviors.push({});
    await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'first')],
        baseVars: { token: 'before-script' },
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    expect(injectVariablesMock).not.toHaveBeenCalled();
  });

  it('records an aborted run outcome', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'first')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      ac.signal
    );
    expect(result.outcome).toBe('aborted');
  });
});
