import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection, HttpRequest } from '@/types';
import type { RunnableRequest } from '../flattenRunnables';

/**
 * Phase C runner test — `pm.execution.setNextRequest('B')` causes the
 * runner to jump to a named runnable, skipping intermediate ones. Mirrors
 * Newman's behaviour: name-based lookup, first match wins, null ends the
 * iteration, an unknown target produces a failed runner result, and a
 * self-loop hits the 1000-jump cap.
 *
 * Mocks the protocol registry so the test runs offline and we can inject
 * synthetic execution sentinels per-request.
 */

interface FakeBehavior {
  /** Sentinel surfaced via onScriptResult.test.execution.nextRequest. */
  nextRequest?: string | null | undefined;
  /** Sentinel surfaced via onScriptResult.preRequest.execution.skipRequested. */
  skipRequested?: boolean;
}

const ran: string[] = [];
const behaviors = new Map<string, FakeBehavior>();

// biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
const runRequestMock = vi.fn(async (req: HttpRequest, ctx: any) => {
  ran.push(req.name);
  const b = behaviors.get(req.name);
  if (b?.nextRequest !== undefined) {
    ctx.onScriptResult?.({
      test: {
        success: true,
        logs: [],
        errors: [],
        variables: {},
        tests: [],
        execution: { nextRequest: b.nextRequest },
      },
    });
  }
  if (b?.skipRequested) {
    ctx.onScriptResult?.({
      preRequest: {
        success: true,
        logs: [],
        errors: [],
        variables: {},
        tests: [],
        execution: { skipRequested: true },
      },
    });
  }
  return {
    id: 'r-' + req.name,
    requestId: req.id,
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
    get: (id: string) => {
      if (id === 'http') {
        return {
          id: 'http',
          runRequest: runRequestMock,
          injectVariables: (r: unknown) => r,
        };
      }
      return undefined;
    },
  },
}));

// Import after the mock is in place.
import { runCollection } from '../collectionRunner';

function httpReq(id: string, name: string): HttpRequest {
  return {
    id,
    name,
    type: 'http',
    method: 'GET',
    url: 'https://example.test/' + name,
    headers: [],
    params: [],
    body: { type: 'none', raw: '' },
    auth: { type: 'none' },
  } as unknown as HttpRequest;
}

function runnable(id: string, name: string): RunnableRequest {
  return { itemId: id, name, request: httpReq(id, name) };
}

const collection: Collection = { id: 'c', name: 'C', items: [] } as Collection;
const noop = () => undefined;

function baseOptions(runnables: RunnableRequest[]) {
  return {
    collection,
    scopeName: 'C',
    runnables,
    baseVars: {},
    iterations: 1,
    dataRows: [],
    delayMs: 0,
    stopOnFailure: false,
  };
}

beforeEach(() => {
  ran.length = 0;
  behaviors.clear();
  runRequestMock.mockClear();
});

describe('runCollection — pm.execution.setNextRequest', () => {
  it('jumps to a named runnable, skipping the one in between', async () => {
    behaviors.set('A', { nextRequest: 'C' });
    const result = await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'A'), runnable('2', 'B'), runnable('3', 'C')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    expect(ran).toEqual(['A', 'C']);
    expect(result.requests.map((r) => r.itemName)).toEqual(['A', 'C']);
  });

  it('setNextRequest(null) ends the iteration early', async () => {
    behaviors.set('A', { nextRequest: null });
    const result = await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'A'), runnable('2', 'B'), runnable('3', 'C')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    expect(ran).toEqual(['A']);
    expect(result.requests.map((r) => r.itemName)).toEqual(['A']);
  });

  it('unknown target name produces a failed runner result and stops the iteration', async () => {
    behaviors.set('A', { nextRequest: 'NonExistent' });
    const result = await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'A'), runnable('2', 'B')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    expect(ran).toEqual(['A']);
    const last = result.requests[result.requests.length - 1];
    expect(last?.status).toBe('failed');
    expect(last?.error).toMatch(/no runnable with that name/);
  });

  // Explicit 5s per-test timeout — if MAX_NEXT_REQUEST_JUMPS regresses or
  // the index loop misbehaves, this test would otherwise hang until the
  // suite-level timeout and noisily mask the actual failure.
  it('caps self-loop jumps at 1000', { timeout: 5000 }, async () => {
    behaviors.set('A', { nextRequest: 'A' });
    const result = await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('1', 'A')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      noop,
      new AbortController().signal
    );
    // A ran (1001x: the initial + 1000 jumps), then the limit-error result.
    expect(ran.length).toBe(1001);
    const last = result.requests[result.requests.length - 1];
    expect(last?.error).toMatch(/jump limit/);
  });

  // `indexByName` was a plain object: inherited names resolved to functions,
  // and requests with those names could never be jump targets.
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'reports setNextRequest(%j) as an unknown target when nothing has that name',
    async (target) => {
      behaviors.set('A', { nextRequest: target });
      const result = await runCollection(
        baseOptions([runnable('1', 'A'), runnable('2', 'B')]),
        noop,
        new AbortController().signal
      );
      expect(ran).toEqual(['A']);
      const last = result.requests[result.requests.length - 1];
      expect(last?.status).toBe('failed');
      expect(last?.error).toBe(
        `pm.execution.setNextRequest("${target}"): no runnable with that name`
      );
    }
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'jumps to a runnable actually named %j',
    async (name) => {
      behaviors.set('A', { nextRequest: name });
      const result = await runCollection(
        baseOptions([runnable('1', 'A'), runnable('2', 'B'), runnable('3', name)]),
        noop,
        new AbortController().signal
      );
      expect(ran).toEqual(['A', name]);
      expect(result.requests.map((r) => r.status)).toEqual(['success', 'success']);
    }
  );
});

// Host wiring the sequencer table test cannot see. Each pins today's app
// behaviour; the CLI's differing behaviour is pinned in its flowControl.test.ts.
describe('runCollection — app sequencing pins', () => {
  it('stopOnFailure does not stop on an unknown target; the next row still runs', async () => {
    behaviors.set('A', { nextRequest: 'Nope' });
    const result = await runCollection(
      { ...baseOptions([runnable('1', 'A')]), stopOnFailure: true, dataRows: [{}, {}] },
      noop,
      new AbortController().signal
    );
    expect(result.requests.map((r) => [r.iteration, r.status])).toEqual([
      [0, 'success'],
      [0, 'failed'],
      [1, 'success'],
      [1, 'failed'],
    ]);
    expect(result.outcome).toBe('completed');
  });

  it('stopOnFailure does not stop on a blocked runnable', async () => {
    const result = await runCollection(
      {
        ...baseOptions([{ ...runnable('1', 'Blocked'), blocked: 'not sent' }, runnable('2', 'B')]),
        stopOnFailure: true,
      },
      noop,
      new AbortController().signal
    );
    expect(result.requests.map((r) => r.status)).toEqual(['skipped', 'success']);
    expect(ran).toEqual(['B']);
  });

  // Pinned parity gap: the CLI honours pm.execution.skipRequest(); the app's
  // Collection run ignores the sentinel, so the request counts as sent.
  it('ignores pm.execution.skipRequest()', async () => {
    behaviors.set('A', { skipRequested: true });
    const result = await runCollection(
      baseOptions([runnable('1', 'A')]),
      noop,
      new AbortController().signal
    );
    expect(ran).toEqual(['A']);
    expect(result.requests[0]?.status).toBe('success');
  });

  it('waits delayMs after every sent request, including the last', async () => {
    const started = Date.now();
    await runCollection(
      { ...baseOptions([runnable('1', 'A')]), delayMs: 150 },
      noop,
      new AbortController().signal
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('does not wait delayMs after a skipped runnable', async () => {
    const started = Date.now();
    await runCollection(
      { ...baseOptions([{ ...runnable('1', 'Blocked'), blocked: 'not sent' }]), delayMs: 2000 },
      noop,
      new AbortController().signal
    );
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
