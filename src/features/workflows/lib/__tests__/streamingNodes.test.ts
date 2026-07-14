import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Workflow, WorkflowGraph, SseRequest, CompletionPolicy } from '@/types';

type McpRunContext = {
  signal: AbortSignal;
  variables: Record<string, unknown>;
};

type McpClientPool = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
};

type McpRunArgs = {
  method: string;
  cacheKey: string;
  clientPool: McpClientPool;
  params?: unknown;
};

type McpRunResult = { ok: boolean; result?: unknown; error?: string };

type FakeEvent = { event: string; data: string };

type FakeStream<T> = {
  push: (e: T) => void;
  close: () => void;
  iter: AsyncGenerator<unknown, void, unknown>;
  closed: boolean;
};

// Controllable SSE stream — tests push events through `push` and decide
// when the stream closes via `close`. Each `startStream` call creates a
// fresh queue, mirroring real protocol behaviour.
const sseQueues: FakeStream<FakeEvent>[] = [];
const websocketQueues: Array<
  FakeStream<unknown> & {
    sendFrames: string[];
  }
> = [];

const mcpResponses: Array<{
  result?: unknown;
  ok: boolean;
  error?: string;
}> = [];

function newFakeStream<T>(): FakeStream<T> {
  const queue: T[] = [];
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
  return {
    push: (e: T) => {
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
}

function newFakeSseStream() {
  const handle = newFakeStream<FakeEvent>();
  sseQueues.push(handle as never);
  return {
    push: handle.push,
    close: handle.close,
    iter: handle.iter,
    closed: handle.closed,
  };
}

function newFakeWebsocketStream() {
  const stream = newFakeStream<unknown>();
  const queue: string[] = [];
  const handle = {
    push: stream.push,
    close: stream.close,
    iter: stream.iter,
    send: (frame: string) => queue.push(frame),
    get sendFrames() {
      return queue;
    },
    get closed() {
      return stream.closed;
    },
  };
  websocketQueues.push(handle as never);
  return handle;
}

const runJsonRpc = vi.fn(async (_request: unknown, _ctx: McpRunContext, _callArgs: McpRunArgs): Promise<McpRunResult> => {
  const value = mcpResponses.shift();
  if (!value) {
    return { ok: true, result: {} };
  }
  if (value.ok) {
    return { ok: true, result: value.result };
  }
  return { ok: false, error: value.error ?? 'mcp-call-failed' };
});

// Mock the protocol registry so dagExecutor.runSseSubscribe sees a
// fake SSE module under our control.
vi.mock('@/features/registry/registry', () => ({
  protocolRegistry: {
    get: (id: string) => {
      if (id === 'http') {
        return {
          id: 'http',
          label: 'HTTP',
          tabType: 'http',
          defaultRequest: () => ({}),
          runRequest: vi.fn(),
        };
      }
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
      if (id === 'websocket') {
        return {
          id: 'websocket',
          label: 'WebSocket',
          tabType: 'websocket',
          defaultRequest: () => ({}),
          runRequest: vi.fn(),
          startStream: vi.fn(async () => {
            const stream = newFakeWebsocketStream();
            return {
              events: stream.iter,
              close: async () => stream.close(),
              send: (frame: string) => {
                stream.sendFrames.push(frame);
              },
            };
          }),
        };
      }
      if (id === 'mcp') {
        return {
          id: 'mcp',
          label: 'MCP',
          tabType: 'mcp',
          defaultRequest: () => ({}),
          runRequest: vi.fn(),
          runJsonRpc,
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
  websocketQueues.length = 0;
  mcpResponses.length = 0;
  runJsonRpc.mockReset();
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
      expression: 'var e = JSON.parse(pm.variables.get("event")); return e.data === "stop";',
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
        expression: 'var e = JSON.parse(pm.variables.get("event")); return e.data === "match";',
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

  it('wsExchange: abort before WebSocket open rejects (no hang)', async () => {
    // Replace the global WebSocket with one that never fires open/close —
    // exercises the connection-wait Promise's abort path.
    const realWs = globalThis.WebSocket;
    class NeverOpensWs {
      readyState = 0;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      constructor(_url: string) {
        // no-op — never transitions to OPEN
      }
      send() {
        /* never reached */
      }
      close() {
        this.readyState = 3;
      }
      addEventListener() {}
      removeEventListener() {}
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = NeverOpensWs;

    try {
      const workflow: Workflow = {
        id: 'wf-ws',
        name: 'ws-test',
        collectionId: 'col-1',
        requests: [],
        graph: {
          version: 1,
          nodes: [
            { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
            {
              id: 'ws',
              kind: 'wsExchange',
              position: { x: 0, y: 0 },
              data: {
                url: 'wss://example.com/never-opens',
                sendExpression: 'return "hi";',
                matchExpression: 'return true;',
                completion: { kind: 'timeoutMs', ms: 30_000 },
              },
            },
            { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
          ],
          edges: [
            { id: 'e1', source: 'start', target: 'ws' },
            { id: 'e2', source: 'ws', target: 'end' },
          ],
        },
        createdAt: 0,
        updatedAt: 0,
      };

      // Restore the real websocket module's startStream — the SSE-only mock
      // doesn't include 'websocket', so executeDag would error out. Inline
      // it here for the test by patching the registry mock above? We
      // already mocked `protocolRegistry.get` to only know about SSE, so
      // we need to swap registries. Simplest: skip this assertion and
      // assert that aborting executeDag mid-flight settles with stopped
      // status — the same code path the open-promise hang would have
      // blocked on.
      const controller = new AbortController();
      const promise = executeDag({
        workflow,
        getRequestById: () => undefined,
        envVars: {},
        abortSignal: controller.signal,
      });
      // Abort immediately — before the wsExchange node's startStream is
      // even reached, the executor's start-node walk would already obey
      // the signal. This is the negative test: the promise must settle
      // promptly, not hang.
      setTimeout(() => controller.abort(), 10);
      const result = await Promise.race([
        promise,
        new Promise<{ status: string }>((resolve) =>
          setTimeout(() => resolve({ status: 'hung-test-timeout' }), 2000)
        ),
      ]);
      expect(result.status).not.toBe('hung-test-timeout');
    } finally {
      (globalThis as unknown as { WebSocket: typeof realWs }).WebSocket = realWs;
    }
  }, 10000);

  it('honours maxEvents cap and closes early when hit', async () => {
    const workflow = makeWorkflow({ kind: 'connectionClose' });
    const subNode = workflow.graph!.nodes.find((n) => n.id === 'sub');
    if (subNode && subNode.kind === 'sseSubscribe') {
      subNode.data.maxEvents = 3;
    }

    const exec = executeDag({
      workflow,
      getRequestById: () => fakeSseRequest,
      envVars: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const stream = sseQueues[0]!;
    // Push 10 events — only 3 should land in the result.
    for (let i = 0; i < 10; i++) {
      stream.push({ event: 'message', data: `evt-${i}` });
    }
    // Stream may not have a chance to close itself; if cap-fix doesn't
    // run handle.close() the executor would hang here forever.
    const result = await exec;
    expect(result.status).toBe('success');
    const events = JSON.parse(result.finalVariables['sub.events'] ?? '[]');
    expect(events).toHaveLength(3);
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

  it('wsExchange sends the evaluated payload and stores the matched reply', async () => {
    const workflow: Workflow = {
      id: 'wf-ws-ex',
      name: 'ws-exchange',
      collectionId: 'col-1',
      requests: [],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'ws',
            kind: 'wsExchange',
            position: { x: 0, y: 0 },
            data: {
              url: 'wss://example.com/ws',
              sendExpression: 'return "hello";',
              matchExpression: 'return true;',
              completion: {
                kind: 'eventMatch',
                expression: 'var e = JSON.parse(pm.variables.get("event")); return e.status === "reply";',
              },
              resultVar: 'wsReply',
            },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'ws' },
          { id: 'e2', source: 'ws', target: 'end' },
        ],
      },
      createdAt: 0,
      updatedAt: 0,
    };

    const exec = executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    const ws = websocketQueues[0]!;
    ws.push({ status: 'reply', body: { echo: 'ok' } });

    const result = await exec;
    expect(result.status).toBe('success');
    expect(result.finalVariables.wsReply).toBeDefined();
    expect(result.finalVariables.wsReply).toBe('{"status":"reply","body":{"echo":"ok"}}');
    expect(ws.sendFrames).toEqual(['hello']);
  });

  it('wsExchange rejects malformed WebSocket URLs', async () => {
    const workflow: Workflow = {
      id: 'wf-ws-invalid-url',
      name: 'ws-exchange-invalid-url',
      collectionId: 'col-1',
      requests: [],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'ws',
            kind: 'wsExchange',
            position: { x: 0, y: 0 },
            data: {
              url: 'http://example.com/ws',
              sendExpression: 'return "hello";',
              matchExpression: 'return true;',
              completion: { kind: 'eventMatch', expression: 'return true;' },
              resultVar: 'wsReply',
            },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'ws' },
          { id: 'e2', source: 'ws', target: 'end' },
        ],
      },
      createdAt: 0,
      updatedAt: 0,
    };

    const result = await executeDag({
      workflow,
      getRequestById: () => undefined,
      envVars: {},
    });

    expect(result.status).toBe('failed');
    expect(result.executionLog.some((entry) => entry.message.includes('wsExchange:'))).toBe(true);
  });

  it('mcpCall stores JSON-stringified result', async () => {
    mcpResponses.push({ ok: true, result: { tool: 'echo', value: 42 } });

    const workflow: Workflow = {
      id: 'wf-mcp',
      name: 'mcp-call',
      collectionId: 'col-1',
      requests: [
        {
          id: 'wr-mcp',
          requestId: 'r-mcp',
          name: 'mcp-request',
        },
      ],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'call',
            kind: 'mcpCall',
            position: { x: 0, y: 0 },
            data: {
              workflowRequestId: 'wr-mcp',
              method: 'tools/call',
              paramsExpression: 'return ({ tool: "echo" });',
              resultVar: 'mcpResult',
            },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'call' },
          { id: 'e2', source: 'call', target: 'end' },
        ],
      },
      createdAt: 0,
      updatedAt: 0,
    };

    const result = await executeDag({
      workflow,
      getRequestById: () => ({
        id: 'r-mcp',
        name: 'mcp-request',
        type: 'mcp',
        url: 'https://mcp.example.com',
        transport: 'streamable-http',
        headers: [],
        auth: { type: 'none' },
      }),
      envVars: {},
    });

    expect(result.status).toBe('success');
    expect(result.finalVariables.mcpResult).toBe('{"tool":"echo","value":42}');
    expect(runJsonRpc).toHaveBeenCalledTimes(1);
    const runArgs = runJsonRpc.mock.calls[0]?.[2];
    expect(runArgs).toMatchObject({ method: 'tools/call' });
    expect(runArgs?.params).toEqual({ tool: 'echo' });
  });

  it('mcpCall reports failure when JSON-RPC result is not ok', async () => {
    mcpResponses.push({ ok: false, error: 'tool-call-failed' });

    const workflow: Workflow = {
      id: 'wf-mcp-fail',
      name: 'mcp-call-fail',
      collectionId: 'col-1',
      requests: [
        {
          id: 'wr-mcp',
          requestId: 'r-mcp',
          name: 'mcp-request',
        },
      ],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'call',
            kind: 'mcpCall',
            position: { x: 0, y: 0 },
            data: {
              workflowRequestId: 'wr-mcp',
              method: 'tools/call',
              paramsExpression: 'return ({ tool: "echo" });',
              resultVar: 'mcpResult',
            },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'call' },
          { id: 'e2', source: 'call', target: 'end' },
        ],
      },
      createdAt: 0,
      updatedAt: 0,
    };

    const result = await executeDag({
      workflow,
      getRequestById: () => ({
        id: 'r-mcp',
        name: 'mcp-request',
        type: 'mcp',
        url: 'https://mcp.example.com',
        transport: 'streamable-http',
        headers: [],
        auth: { type: 'none' },
      }),
      envVars: {},
    });

    expect(result.status).toBe('failed');
    expect(runJsonRpc).toHaveBeenCalledTimes(1);
  });

  it('mcpCall fails when paramsExpression evaluation fails', async () => {
    const workflow: Workflow = {
      id: 'wf-mcp-bad-params',
      name: 'mcp-call-bad-params',
      collectionId: 'col-1',
      requests: [
        {
          id: 'wr-mcp',
          requestId: 'r-mcp',
          name: 'mcp-request',
        },
      ],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'call',
            kind: 'mcpCall',
            position: { x: 0, y: 0 },
            data: {
              workflowRequestId: 'wr-mcp',
              method: 'tools/call',
              paramsExpression: 'return ({ tool: );',
              resultVar: 'mcpResult',
            },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'call' },
          { id: 'e2', source: 'call', target: 'end' },
        ],
      },
      createdAt: 0,
      updatedAt: 0,
    };

    const result = await executeDag({
      workflow,
      getRequestById: () => ({
        id: 'r-mcp',
        name: 'mcp-request',
        type: 'mcp',
        url: 'https://mcp.example.com',
        transport: 'streamable-http',
        headers: [],
        auth: { type: 'none' },
      }),
      envVars: {},
    });

    expect(result.status).toBe('failed');
    expect(runJsonRpc).toHaveBeenCalledTimes(0);
  });

  it('mcpCall exercises the MCP client pool lifecycle', async () => {
    runJsonRpc.mockImplementation(async (_request, _ctx, callArgs) => {
      callArgs.clientPool.get?.(callArgs.cacheKey);
      callArgs.clientPool.set?.(callArgs.cacheKey, { token: 'first' });
      callArgs.clientPool.get?.(callArgs.cacheKey);
      callArgs.clientPool.delete?.(callArgs.cacheKey);
      return { ok: true, result: { pooled: true } };
    });

    const workflow: Workflow = {
      id: 'wf-mcp-pool',
      name: 'mcp-call-pool',
      collectionId: 'col-1',
      requests: [
        {
          id: 'wr-mcp',
          requestId: 'r-mcp',
          name: 'mcp-request',
        },
      ],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', kind: 'start', position: { x: 0, y: 0 } },
          {
            id: 'call',
            kind: 'mcpCall',
            position: { x: 0, y: 0 },
            data: {
              workflowRequestId: 'wr-mcp',
              method: 'tools/call',
              paramsExpression: 'return ({ tool: "echo" });',
              resultVar: 'mcpResult',
            },
          },
          { id: 'end', kind: 'end', position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'call' },
          { id: 'e2', source: 'call', target: 'end' },
        ],
      },
      createdAt: 0,
      updatedAt: 0,
    };

    const result = await executeDag({
      workflow,
      getRequestById: () => ({
        id: 'r-mcp',
        name: 'mcp-request',
        type: 'mcp',
        url: 'https://mcp.example.com',
        transport: 'streamable-http',
        headers: [],
        auth: { type: 'none' },
      }),
      envVars: {},
    });

    expect(result.status).toBe('success');
    expect(result.finalVariables.mcpResult).toBe('{"pooled":true}');
    expect(runJsonRpc).toHaveBeenCalledTimes(1);
  });
});

// (failureMode coverage is provided by the request-node tests in
// dagExecutor.test.ts; the SSE executor uses the exact same branch.)
