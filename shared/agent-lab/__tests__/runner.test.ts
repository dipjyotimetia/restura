import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSuite } from '../types';
import type { GenerationRequest, GenerationResponse, ProviderAdapter } from '../provider';
import { ProviderRegistry } from '../provider';
import { AgentRunner, type AgentTool } from '../runner';

const capabilities = {
  inputModalities: ['text'] as const,
  outputModalities: ['text'] as const,
  structuredOutput: false,
  toolCalling: true,
  parallelToolCalls: true,
  reasoning: false,
  continuation: false,
  serverTools: [],
};

function suite(maxSteps = 4): AgentSuite {
  return {
    schemaVersion: 2,
    id: 'suite',
    name: 'Suite',
    mode: 'regression',
    agents: [
      {
        id: 'agent',
        model: { providerId: 'fake', model: 'model' },
        instructions: 'Use tools.',
        tools: [{ kind: 'restura-request', requestId: 'request-1' }],
        limits: { maxSteps, maxWallTimeMs: 10_000 },
      },
    ],
    tasks: [{ id: 'task', input: [{ type: 'text', text: 'Lookup order 42' }] }],
    graders: [],
    trials: 1,
  };
}

function fakeAdapter(responses: GenerationResponse[]): ProviderAdapter {
  let index = 0;
  return {
    id: 'fake',
    async discoverModels() {
      return [];
    },
    async getCapabilities() {
      return capabilities;
    },
    async generate() {
      return responses[index++]!;
    },
  };
}

const lookupTool: AgentTool = {
  definition: {
    name: 'orders.get',
    description: 'Get an order',
    inputSchema: { type: 'object' },
  },
  permissionClass: 'read',
  async execute(args) {
    return [{ type: 'json', value: { args, status: 'paid' } }];
  },
};

describe('AgentRunner', () => {
  afterEach(() => vi.useRealTimers());
  it('executes a tool loop and records a strictly ordered trace', async () => {
    const registry = new ProviderRegistry([
      fakeAdapter([
        {
          id: 'r1',
          output: [],
          toolCalls: [{ id: 'call-1', name: 'orders.get', arguments: { id: 42 } }],
          stopReason: 'tool-calls',
        },
        {
          id: 'r2',
          output: [{ type: 'text', text: 'Order 42 is paid.' }],
          toolCalls: [],
          stopReason: 'completed',
        },
      ]),
    ]);
    const runner = new AgentRunner({
      providers: registry,
      async resolveTools() {
        return [lookupTool];
      },
      async resolveCredential() {
        return undefined;
      },
    });

    const result = await runner.run({ suite: suite(), taskId: 'task', agentId: 'agent', trial: 1 });

    expect(result.status).toBe('passed');
    expect(result.output).toEqual([{ type: 'text', text: 'Order 42 is paid.' }]);
    expect(result.trace.events.map((event) => event.type)).toEqual([
      'run.started',
      'model.requested',
      'model.completed',
      'tool.requested',
      'tool.completed',
      'model.requested',
      'model.completed',
      'run.completed',
    ]);
    expect(result.trace.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('denies sensitive tools before execution when approval is refused', async () => {
    let executed = false;
    const mutationTool: AgentTool = {
      ...lookupTool,
      permissionClass: 'mutation',
      async execute() {
        executed = true;
        return [];
      },
    };
    const runner = new AgentRunner({
      providers: new ProviderRegistry([
        fakeAdapter([
          {
            id: 'r1',
            output: [],
            toolCalls: [{ id: 'call-1', name: 'orders.get', arguments: {} }],
          },
        ]),
      ]),
      async resolveTools() {
        return [mutationTool];
      },
      async resolveCredential() {
        return undefined;
      },
      async requestApproval() {
        return 'denied';
      },
    });

    const result = await runner.run({ suite: suite(), taskId: 'task', agentId: 'agent', trial: 1 });

    expect(executed).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toContain('approval denied');
    expect(result.trace.events.map((event) => event.type)).toContain('approval.resolved');
  });

  it('stops a non-terminating model at the configured step limit', async () => {
    const repeated = Array.from({ length: 3 }, (_, index) => ({
      id: `r${index}`,
      output: [],
      toolCalls: [{ id: `call-${index}`, name: 'orders.get', arguments: {} }],
    }));
    const runner = new AgentRunner({
      providers: new ProviderRegistry([fakeAdapter(repeated)]),
      async resolveTools() {
        return [lookupTool];
      },
      async resolveCredential() {
        return undefined;
      },
    });

    const result = await runner.run({
      suite: suite(2),
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });

    expect(result.status).toBe('error');
    expect(result.error).toBe('agent exceeded maxSteps (2)');
  });

  it('actively aborts a hung provider at the wall-time limit', async () => {
    vi.useFakeTimers();
    const adapter = fakeAdapter([]);
    adapter.generate = async (_request, context) =>
      new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    const runner = new AgentRunner({
      providers: new ProviderRegistry([adapter]),
      async resolveTools() {
        return [];
      },
      async resolveCredential() {
        return undefined;
      },
    });
    const configured = suite();
    configured.agents[0]!.limits.maxWallTimeMs = 100;
    const pending = runner.run({ suite: configured, taskId: 'task', agentId: 'agent', trial: 1 });
    await vi.advanceTimersByTimeAsync(101);
    const result = await pending;
    expect(result.status).toBe('error');
    expect(result.error).toBe('agent exceeded maxWallTimeMs (100)');
  });

  it('applies the output byte budget to untrusted tool output', async () => {
    const configured = suite();
    configured.agents[0]!.limits.maxOutputBytes = 1024;
    const runner = new AgentRunner({
      providers: new ProviderRegistry([
        fakeAdapter([
          {
            id: 'r1',
            output: [],
            toolCalls: [{ id: 'call', name: 'large', arguments: {} }],
          },
        ]),
      ]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [
          {
            definition: { name: 'large', description: 'large', inputSchema: {} },
            permissionClass: 'read',
            async execute() {
              return [{ type: 'text' as const, text: 'x'.repeat(2_000) }];
            },
          },
        ];
      },
    });
    const result = await runner.run({
      suite: configured,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('exceeded maxOutputBytes (1024)');
  });

  it('applies the output byte budget to opaque provider continuation state', async () => {
    const configured = suite();
    configured.agents[0]!.limits.maxOutputBytes = 1024;
    const runner = new AgentRunner({
      providers: new ProviderRegistry([
        fakeAdapter([
          {
            id: 'r1',
            output: [],
            providerState: [{ type: 'reasoning', encrypted_content: 'x'.repeat(2_000) }],
            toolCalls: [{ id: 'call', name: 'orders.get', arguments: {} }],
          },
        ]),
      ]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [lookupTool];
      },
    });

    const result = await runner.run({
      suite: configured,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('exceeded maxOutputBytes (1024)');
    expect(result.trace.events.map((event) => event.type)).not.toContain('model.completed');
  });

  it('passes only remaining tokens to later turns', async () => {
    const configured = suite();
    configured.agents[0]!.limits.maxTokens = 100;
    const requests: GenerationRequest[] = [];
    const adapter = fakeAdapter([
      {
        id: 'r1',
        output: [],
        toolCalls: [{ id: 'call', name: 'orders.get', arguments: {} }],
        usage: { inputTokens: 50, outputTokens: 0 },
      },
      {
        id: 'r2',
        output: [{ type: 'text', text: 'done' }],
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);
    const generate = adapter.generate.bind(adapter);
    adapter.generate = async (request, context) => {
      requests.push(request);
      return generate(request, context);
    };
    const runner = new AgentRunner({
      providers: new ProviderRegistry([adapter]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [lookupTool];
      },
    });

    const result = await runner.run({
      suite: configured,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });

    expect(result.status).toBe('passed');
    expect(requests.map((request) => request.maxOutputTokens)).toEqual([100, 50]);
  });

  it('fails before tools after token overshoot', async () => {
    const configured = suite();
    configured.agents[0]!.limits.maxTokens = 100;
    let executed = false;
    const runner = new AgentRunner({
      providers: new ProviderRegistry([
        fakeAdapter([
          {
            id: 'r1',
            output: [],
            toolCalls: [{ id: 'call', name: 'orders.get', arguments: {} }],
            usage: { inputTokens: 90, outputTokens: 20 },
          },
        ]),
      ]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [
          {
            ...lookupTool,
            async execute() {
              executed = true;
              return [];
            },
          },
        ];
      },
    });

    const result = await runner.run({
      suite: configured,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });

    expect(result.error).toContain('exceeded maxTokens (100)');
    expect(executed).toBe(false);
    expect(result.trace.events.some((event) => event.type === 'tool.requested')).toBe(false);
    expect(result.trace.events.some((event) => event.type === 'model.completed')).toBe(false);
    expect(result.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'model.failed', error: 'agent exceeded maxTokens (100)' }),
      ])
    );
  });

  it('fails closed when usage is absent under a token budget', async () => {
    const configured = suite();
    configured.agents[0]!.limits.maxTokens = 100;
    const runner = new AgentRunner({
      providers: new ProviderRegistry([
        fakeAdapter([{ id: 'r1', output: [{ type: 'text', text: 'done' }], toolCalls: [] }]),
      ]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [];
      },
    });

    const result = await runner.run({
      suite: configured,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });

    expect(result.error).toContain('provider usage is unknown');
    expect(result.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model.failed',
          error: expect.stringContaining('provider usage is unknown'),
        }),
      ])
    );
  });

  it('accepts a terminal response that exactly consumes the token budget', async () => {
    const configured = suite();
    configured.agents[0]!.limits.maxTokens = 100;
    const runner = new AgentRunner({
      providers: new ProviderRegistry([
        fakeAdapter([
          {
            id: 'r1',
            output: [{ type: 'text', text: 'done' }],
            toolCalls: [],
            usage: { inputTokens: 80, outputTokens: 20 },
          },
        ]),
      ]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [];
      },
    });

    const result = await runner.run({
      suite: configured,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });

    expect(result.status).toBe('passed');
    expect(result.output).toEqual([{ type: 'text', text: 'done' }]);
    expect(result.trace.events.some((event) => event.type === 'model.completed')).toBe(true);
  });

  it('rejects an exactly exhausted tool response before tools or another provider call', async () => {
    const configured = suite();
    configured.agents[0]!.limits.maxTokens = 100;
    let providerCalls = 0;
    let executed = false;
    const adapter = fakeAdapter([
      {
        id: 'r1',
        output: [],
        toolCalls: [{ id: 'call', name: 'orders.get', arguments: {} }],
        usage: { inputTokens: 80, outputTokens: 20 },
      },
    ]);
    const generate = adapter.generate.bind(adapter);
    adapter.generate = async (request, context) => {
      providerCalls += 1;
      return generate(request, context);
    };
    const runner = new AgentRunner({
      providers: new ProviderRegistry([adapter]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [
          {
            ...lookupTool,
            async execute() {
              executed = true;
              return [];
            },
          },
        ];
      },
    });

    const result = await runner.run({
      suite: configured,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });

    expect(result.error).toBe('agent exceeded maxTokens (100)');
    expect(providerCalls).toBe(1);
    expect(executed).toBe(false);
    expect(result.trace.events.some((event) => event.type === 'model.completed')).toBe(false);
    expect(result.trace.events.some((event) => event.type === 'tool.requested')).toBe(false);
  });

  it.each([
    ['partial', { inputTokens: 10 }],
    ['negative', { inputTokens: -1, outputTokens: 1 }],
    ['fractional', { inputTokens: 1.5, outputTokens: 1 }],
    ['NaN', { inputTokens: Number.NaN, outputTokens: 1 }],
    ['Infinity', { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 1 }],
  ])('rejects %s provider usage before model completion or tools', async (_label, usage) => {
    const configured = suite();
    configured.agents[0]!.limits.maxTokens = 100;
    let approved = false;
    let executed = false;
    const invalidResponse = {
      id: 'r1',
      output: [],
      toolCalls: [{ id: 'call', name: 'orders.get', arguments: {} }],
      usage,
    } as unknown as GenerationResponse;
    const runner = new AgentRunner({
      providers: new ProviderRegistry([fakeAdapter([invalidResponse])]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [
          {
            ...lookupTool,
            permissionClass: 'mutation',
            async execute() {
              executed = true;
              return [];
            },
          },
        ];
      },
      async requestApproval() {
        approved = true;
        return 'approved';
      },
    });

    const result = await runner.run({
      suite: configured,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });

    expect(result.error).toBe('agent cannot enforce maxTokens because provider usage is invalid');
    expect(approved).toBe(false);
    expect(executed).toBe(false);
    expect(result.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model.failed',
          error: 'agent cannot enforce maxTokens because provider usage is invalid',
        }),
      ])
    );
    expect(result.trace.events.some((event) => event.type === 'model.completed')).toBe(false);
    expect(result.trace.events.some((event) => event.type === 'tool.requested')).toBe(false);
    expect(result.trace.events.some((event) => event.type === 'approval.requested')).toBe(false);
  });

  it('validates provider tool arguments before approval or execution', async () => {
    let executed = false;
    const runner = new AgentRunner({
      providers: new ProviderRegistry([
        fakeAdapter([
          {
            id: 'r1',
            output: [],
            toolCalls: [{ id: 'call', name: 'typed', arguments: { id: 'wrong' } }],
          },
        ]),
      ]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [
          {
            definition: {
              name: 'typed',
              description: 'typed',
              inputSchema: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'number' } },
              },
            },
            permissionClass: 'mutation',
            async execute() {
              executed = true;
              return [];
            },
          },
        ];
      },
      async requestApproval() {
        throw new Error('must not request approval');
      },
    });
    const result = await runner.run({ suite: suite(), taskId: 'task', agentId: 'agent', trial: 1 });
    expect(executed).toBe(false);
    expect(result.error).toContain('invalid arguments for tool typed');
    expect(result.trace.events.map((event) => event.type)).toContain('tool.failed');
  });
});
