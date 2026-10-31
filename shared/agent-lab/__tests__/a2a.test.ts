import { describe, expect, it, vi } from 'vitest';
import {
  A2aClient,
  type A2aHttpRequest,
  type A2aTransport,
  a2aToolName,
  createA2aToolSourceAdapter,
} from '../a2a';

const CARD = {
  name: 'Travel Planner',
  description: 'Plans trips.',
  url: 'https://agent.example/a2a',
  skills: [{ id: 'plan', name: 'Plan trip', description: 'Builds an itinerary' }],
};

function rpcResult(result: unknown) {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: '1', result }) };
}

function task(state: string, extra: Record<string, unknown> = {}) {
  return { kind: 'task', id: 't-1', contextId: 'ctx-1', status: { state }, ...extra };
}

/** Routes GETs to the card and POSTs through a queue of JSON-RPC replies. */
function transport(replies: Array<{ status: number; body: string }>, card: unknown = CARD) {
  const calls: Array<A2aHttpRequest & { rpc?: { method: string; params: unknown } }> = [];
  const fn: A2aTransport = vi.fn(async (request) => {
    const rpc = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ ...request, ...(rpc ? { rpc } : {}) });
    if (request.method === 'GET') {
      return request.url.endsWith('/.well-known/agent-card.json')
        ? { status: 200, body: JSON.stringify(card) }
        : { status: 404, body: '' };
    }
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected call');
    return reply;
  });
  return { fn, calls };
}

describe('A2A client (#1043)', () => {
  it('fetches the well-known card and returns a completed task artifact', async () => {
    const { fn, calls } = transport([
      rpcResult(
        task('completed', { artifacts: [{ parts: [{ kind: 'text', text: '3 days in Rome' }] }] })
      ),
    ]);
    const client = new A2aClient('https://agent.example', fn);
    const result = await client.send({ message: 'Plan Rome' });

    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://agent.example/.well-known/agent-card.json',
    });
    expect(calls[1]?.url).toBe('https://agent.example/a2a');
    expect(calls[1]?.rpc).toMatchObject({
      method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'Plan Rome' }] } },
    });
    expect(result).toEqual({
      state: 'completed',
      taskId: 't-1',
      contextId: 'ctx-1',
      content: [{ type: 'text', text: '3 days in Rome' }],
    });
  });

  it('accepts a direct agent card URL and a plain message reply', async () => {
    const card = vi.fn<A2aTransport>(async (request) =>
      request.method === 'GET'
        ? { status: 200, body: JSON.stringify(CARD) }
        : rpcResult({ kind: 'message', parts: [{ kind: 'data', data: { ok: true } }] })
    );
    const client = new A2aClient('https://agent.example/cards/planner.json', card);
    const result = await client.send({ message: 'hi' });
    expect(card.mock.calls[0]?.[0].url).toBe('https://agent.example/cards/planner.json');
    expect(result.content).toEqual([{ type: 'json', value: { ok: true } }]);
  });

  it('polls tasks/get until the task settles', async () => {
    const { fn, calls } = transport([
      rpcResult(task('working')),
      rpcResult(task('working')),
      rpcResult(
        task('completed', {
          status: {
            state: 'completed',
            message: { kind: 'message', parts: [{ kind: 'text', text: 'done' }] },
          },
        })
      ),
    ]);
    const client = new A2aClient('https://agent.example', fn, { pollIntervalMs: 1 });
    const result = await client.send({ message: 'go' });
    expect(calls.filter((call) => call.rpc?.method === 'tasks/get')).toHaveLength(2);
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('returns input-required so the model can reply with the context', async () => {
    const { fn } = transport([rpcResult(task('input-required'))]);
    const result = await new A2aClient('https://agent.example', fn).send({ message: 'go' });
    expect(result.state).toBe('input-required');
  });

  it('throws on failed tasks and JSON-RPC errors', async () => {
    const failed = transport([
      rpcResult(
        task('failed', {
          status: {
            state: 'failed',
            message: { kind: 'message', parts: [{ kind: 'text', text: 'no flights' }] },
          },
        })
      ),
    ]);
    await expect(
      new A2aClient('https://agent.example', failed.fn).send({ message: 'x' })
    ).rejects.toThrow('A2A task failed: no flights');
    const rpcError = transport([
      {
        status: 200,
        body: JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32601, message: 'nope' } }),
      },
    ]);
    await expect(
      new A2aClient('https://agent.example', rpcError.fn).send({ message: 'x' })
    ).rejects.toThrow('error -32601: nope');
  });

  it('refuses a card that redirects calls to another origin', async () => {
    const { fn } = transport([], { ...CARD, url: 'http://169.254.169.254/a2a' });
    await expect(new A2aClient('https://agent.example', fn).send({ message: 'x' })).rejects.toThrow(
      /not the suite endpoint origin/
    );
  });

  it('refuses non-http endpoints and embedded credentials', () => {
    const { fn } = transport([]);
    expect(() => new A2aClient('file:///etc/passwd', fn)).toThrow(/http or https/);
    expect(() => new A2aClient('https://user:pw@agent.example', fn)).toThrow(/credentials/);
  });

  it('cancels the remote task when the run is aborted mid-poll', async () => {
    const controller = new AbortController();
    const { fn, calls } = transport([rpcResult(task('working')), rpcResult(task('canceled'))]);
    const client = new A2aClient('https://agent.example', fn, { pollIntervalMs: 50 });
    const pending = client.send({ message: 'go' }, controller.signal);
    await vi.waitFor(() =>
      expect(calls.some((call) => call.rpc?.method === 'message/send')).toBe(true)
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() =>
      expect(calls.some((call) => call.rpc?.method === 'tasks/cancel')).toBe(true)
    );
  });

  it('gives up after maxWaitMs', async () => {
    let clock = 0;
    const { fn } = transport([rpcResult(task('working')), rpcResult(task('working'))]);
    const client = new A2aClient('https://agent.example', fn, {
      pollIntervalMs: 1,
      maxWaitMs: 10,
      now: () => (clock += 20),
    });
    await expect(client.send({ message: 'go' })).rejects.toThrow(/did not finish in time/);
  });
});

describe('A2A tool source adapter (#1043)', () => {
  it('builds one approval-required network tool named after the card', async () => {
    const { fn } = transport([
      rpcResult(task('completed', { artifacts: [{ parts: [{ kind: 'text', text: 'ok' }] }] })),
    ]);
    const adapter = createA2aToolSourceAdapter(fn);
    const [tool] = await adapter.resolve({ kind: 'a2a', endpoint: 'https://agent.example' });
    expect(tool?.definition.name).toBe('a2a_Travel_Planner');
    expect(tool?.definition.description).toContain('Plan trip: Builds an itinerary');
    expect(tool?.permissionClass).toBe('network');
    const output = await tool!.execute({ message: 'hi' }, { signal: new AbortController().signal });
    expect(output).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'json', value: { a2a: { state: 'completed', taskId: 't-1', contextId: 'ctx-1' } } },
    ]);
    await expect(tool!.execute({}, { signal: new AbortController().signal })).rejects.toThrow(
      /non-empty message/
    );
  });

  it('keeps tool names inside the provider name rules', () => {
    expect(a2aToolName({ ...CARD, name: '!!!' })).toBe('a2a_agent');
    expect(a2aToolName({ ...CARD, name: 'x'.repeat(100) })).toHaveLength(64);
  });
});
