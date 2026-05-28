import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Collection, HttpRequest } from '@/types';

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
}

const ran: string[] = [];
const behaviors = new Map<string, FakeBehavior>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

function runnable(id: string, name: string) {
  return { itemId: id, name, request: httpReq(id, name) };
}

const collection: Collection = { id: 'c', name: 'C', items: [] } as Collection;
const noop = () => undefined;

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
});
