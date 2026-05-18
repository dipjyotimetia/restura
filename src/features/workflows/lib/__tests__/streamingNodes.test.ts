import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Workflow,
  WorkflowGraph,
  SseRequest,
  CompletionPolicy,
} from '@/types';

// Controllable SSE stream — tests push events through `feedSseEvent`
// and decide when the stream closes via `closeSseStream`. Each `startStream`
// call creates a fresh queue, mirroring real protocol behaviour.
type FakeEvent = { event: string; data: string };
const sseQueues: Array<{
  push: (e: FakeEvent) => void;
  close: () => void;
  iter: AsyncGenerator<unknown, void, unknown>;
  closed: boolean;
}> = [];

function newFakeSseStream() {
  const queue: FakeEvent[] = [];
  let resolveWaiter: (() => void) | null = null;
  const ref = { closed: false } as { closed: boolean };
  const wake = () => {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };
  async function* iterate(): AsyncGenerator<unknown, void, unknown> {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (ref.closed) return;
      await new Promise<void>((res) => {
        resolveWaiter = res;
      });
    }
  }
  const handle = {
    push: (e: FakeEvent) => {
      queue.push(e);
      wake();
    },
    close: () => {
      ref.closed = true;
      wake();
    },
    iter: iterate(),
    get closed() {
      return ref.closed;
    },
  };
  sseQueues.push(handle as never);
  return handle;
}

// Mock the protocol registry so dagExecutor.runSseSubscribe sees a
// fake SSE module under our control.
vi.mock('@/features/registry/registry', () => ({
  protocolRegistry: {
    get: (id: string) => {
      if (id === 'sse') {
        return {
          id: 'sse',
          label: 'SSE',
          tabType: 'sse',
          defaultRequest: () => ({}),
          runRequest: vi.fn(),
          startStream: vi.fn(async (_req: unknown, ctx: { signal: AbortSignal }) => {
            const stream = newFakeSseStream();
            // Hook the abort signal so the executor's abort closes the
            // stream — mirrors what the real sseProtocol does.
            ctx.signal.addEventListener('abort', () => stream.close());
            return {
              events: stream.iter,
              close: async () => stream.close(),
            };
          }),
        };
      }
      return undefined;
    },
  },
}));

const { executeDag } = await import('../dagExecutor');

const fakeSseRequest: SseRequest = {
  id: 'r-sse',
  name: 'sse-feed',
  type: 'sse',
  url: 'http://example.com/sse',
  headers: [],
  params: [],
  auth: { type: 'none' },
};

function makeWorkflow(completion: CompletionPolicy, accumulateAll = true): Workflow {
  const graph: WorkflowGraph = {
    version: 1,
    nodes: [
      { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
      {
        id: 'sub',
        kind: 'sseSubscribe',
        position: { x: 0, y: 0 },
        data: {
          workflowRequestId: 'wr-sse',
          completion,
          accumulateAll,
        },
      },
      { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'sub' },
      { id: 'e2', source: 'sub', target: 'end' },
    ],
  };
  return {
    id: 'wf-1',
    name: 'sse-test',
    collectionId: 'col-1',
    requests: [{ id: 'wr-sse', requestId: 'r-sse', name: 'sse-feed' }],
    graph,
    createdAt: 0,
    updatedAt: 0,
  };
}

beforeEach(() => {
  sseQueues.length = 0;
});

describe('sseSubscribe — completion policies', () => {
  it('eventCount terminates after N events and collects them', async () => {
    const workflow = makeWorkflow({ kind: 'eventCount', n: 3 });
    const exec = executeDag({
      workflow,
      getRequestById: () => fakeSseRequest,
      envVars: {},
    });

    // Wait for the stream to come up.
    await new Promise((r) => setTimeout(r, 10));
    const stream = sseQueues[0]!;
    stream.push({ event: 'message', data: 'one' });
    stream.push({ event: 'message', data: 'two' });
    stream.push({ event: 'message', data: 'three' });
    stream.push({ event: 'message', data: 'four' }); // ignored — already settled
    stream.close();

    const result = await exec;
    expect(result.status).toBe('success');
    const events = JSON.parse(result.finalVariables['sub.events'] ?? '[]');
    expect(events).toHaveLength(3);
  });

  it('connectionClose terminates when stream closes naturally', async () => {
    const workflow = makeWorkflow({ kind: 'connectionClose' });
    const exec = executeDag({
      workflow,
      getRequestById: () => fakeSseRequest,
      envVars: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const stream = sseQueues[0]!;
    stream.push({ event: 'message', data: 'a' });
    stream.push({ event: 'message', data: 'b' });
    stream.close();

    const result = await exec;
    expect(result.status).toBe('success');
    const events = JSON.parse(result.finalVariables['sub.events'] ?? '[]');
    expect(events).toHaveLength(2);
  });

  it('eventMatch terminates when predicate returns truthy', async () => {
    const workflow = makeWorkflow({
      kind: 'eventMatch',
      // Predicate is a JS expression that receives an `event` variable
      // pre-stringified by the executor. Parse and inspect.
      expression:
        'var e = JSON.parse(pm.variables.get("event")); return e.data === "stop";',
    });

    const exec = executeDag({
      workflow,
      getRequestById: () => fakeSseRequest,
      envVars: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const stream = sseQueues[0]!;
    stream.push({ event: 'message', data: 'skip-1' });
    stream.push({ event: 'message', data: 'skip-2' });
    stream.push({ event: 'message', data: 'stop' });
    // Late event ignored
    setTimeout(() => stream.close(), 50);

    const result = await exec;
    expect(result.status).toBe('success');
    const events = JSON.parse(result.finalVariables['sub.events'] ?? '[]');
    // accumulateAll=true so all 3 events are kept; the third triggers stop.
    expect(events).toHaveLength(3);
    expect(events[2]).toEqual({ event: 'message', data: 'stop' });
  }, 30000);

  it('eventMatch with accumulateAll=false stores only matched events', async () => {
    const workflow = makeWorkflow(
      {
        kind: 'eventMatch',
        expression:
          'var e = JSON.parse(pm.variables.get("event")); return e.data === "match";',
      },
      false
    );

    const exec = executeDag({
      workflow,
      getRequestById: () => fakeSseRequest,
      envVars: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const stream = sseQueues[0]!;
    stream.push({ event: 'message', data: 'skip' });
    stream.push({ event: 'message', data: 'match' });
    setTimeout(() => stream.close(), 50);

    const result = await exec;
    expect(result.status).toBe('success');
    const events = JSON.parse(result.finalVariables['sub.events'] ?? '[]');
    expect(events).toEqual([{ event: 'message', data: 'match' }]);
  }, 30000);

  it('abort propagates and closes the stream', async () => {
    const workflow = makeWorkflow({ kind: 'connectionClose' });
    const controller = new AbortController();
    const exec = executeDag({
      workflow,
      getRequestById: () => fakeSseRequest,
      envVars: {},
      abortSignal: controller.signal,
    });

    await new Promise((r) => setTimeout(r, 10));
    const stream = sseQueues[0]!;
    stream.push({ event: 'message', data: 'one' });
    controller.abort();

    const result = await exec;
    expect(['stopped', 'failed']).toContain(result.status);
    // Whichever way the executor settles, the fake stream must have been
    // closed by the abort handler.
    expect(stream.closed).toBe(true);
  });

  it('respects resultVar override', async () => {
    const workflow = makeWorkflow({ kind: 'eventCount', n: 1 });
    // Mutate node to add a custom result var
    const subNode = workflow.graph!.nodes.find((n) => n.id === 'sub');
    if (subNode && subNode.kind === 'sseSubscribe') {
      subNode.data.resultVar = 'myEvents';
    }

    const exec = executeDag({
      workflow,
      getRequestById: () => fakeSseRequest,
      envVars: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const stream = sseQueues[0]!;
    stream.push({ event: 'message', data: 'x' });

    const result = await exec;
    expect(result.status).toBe('success');
    expect(result.finalVariables.myEvents).toBeDefined();
    expect(result.finalVariables['sub.events']).toBeUndefined();
  });
});

// (failureMode coverage is provided by the request-node tests in
// dagExecutor.test.ts; the SSE executor uses the exact same branch.)
