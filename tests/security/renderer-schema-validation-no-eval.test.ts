/**
 * CSP regression: the packaged Electron renderer runs with
 * `script-src 'self' file: 'wasm-unsafe-eval' 'sha256-…'` — no `'unsafe-eval'`
 * (ADR-0026). Ajv v8 compiles validators with `new Function`, which that CSP
 * blocks, so every JSON Schema check the renderer executes must be eval-free.
 *
 * Each test forbids the `Function` constructor (and `eval`) for its duration
 * and drives a renderer-executed validation path: AI Lab tool input schemas
 * (AgentRunner), agent suite graders, AI Lab scorers, and the OpenAPI contract
 * validator. Before the fix these all reached Ajv's `new Function` and failed.
 *
 * Zod v4 probes `new Function` once and JIT-compiles object parsers when it
 * works; under the real CSP the probe fails and Zod falls back. The probe runs
 * before this file's stub, so emulate that fallback with `jitless` before any
 * schema module loads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyOpenAPISpec, OperationMatch } from '@/features/contracts/lib/operationMatcher';
import { validateResponse } from '@/features/contracts/lib/validator';
import type { GenerationResponse, ProviderAdapter } from '../../shared/agent-lab/provider';
import { ProviderRegistry } from '../../shared/agent-lab/provider';
import { AgentRunner, type AgentRunResult, type AgentTool } from '../../shared/agent-lab/runner';
import { AgentSuiteRunner } from '../../shared/agent-lab/suite-runner';
import type { AgentSuite } from '../../shared/agent-lab/types';
import { runScorer, type ScorerContext } from '../../shared/ai-lab/scorers';
import type { ScorerConfig } from '../../shared/ai-lab/types';

// Hoisted above the imports by Vitest.
await vi.hoisted(async () => {
  const { z } = await import('zod');
  z.config({ jitless: true });
});

const CSP_ERROR = 'EvalError: Function constructor is blocked by CSP (no unsafe-eval)';

function forbidCodegen(): void {
  const blocked = new Proxy(globalThis.Function, {
    construct() {
      throw new EvalError(CSP_ERROR);
    },
    apply() {
      throw new EvalError(CSP_ERROR);
    },
  });
  vi.stubGlobal('Function', blocked);
  vi.stubGlobal('eval', () => {
    throw new EvalError(CSP_ERROR);
  });
}

beforeEach(forbidCodegen);
afterEach(() => vi.unstubAllGlobals());

it('the stub really blocks the Function constructor', () => {
  expect(() => new Function('return 1')).toThrow(EvalError);
});

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

function adapter(responses: GenerationResponse[]): ProviderAdapter {
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

const agentSuite: AgentSuite = {
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
      limits: { maxSteps: 4, maxWallTimeMs: 10_000 },
    },
  ],
  tasks: [{ id: 'task', input: [{ type: 'text', text: 'Lookup order 42' }] }],
  graders: [],
  trials: 1,
};

function typedTool(onExecute: () => void): AgentTool {
  return {
    definition: {
      name: 'orders.get',
      description: 'Get an order',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'number' } },
        additionalProperties: false,
      },
    },
    permissionClass: 'read',
    async execute(args) {
      onExecute();
      return [{ type: 'json', value: { args, status: 'paid' } }];
    },
  };
}

describe('AgentRunner tool input schemas without eval', () => {
  it('runs a tool whose arguments match its input schema', async () => {
    let executed = false;
    const runner = new AgentRunner({
      providers: new ProviderRegistry([
        adapter([
          {
            id: 'r1',
            output: [],
            toolCalls: [{ id: 'call', name: 'orders.get', arguments: { id: 42 } }],
            stopReason: 'tool-calls',
          },
          {
            id: 'r2',
            output: [{ type: 'text', text: 'paid' }],
            toolCalls: [],
            stopReason: 'completed',
          },
        ]),
      ]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [typedTool(() => (executed = true))];
      },
    });
    const result = await runner.run({
      suite: agentSuite,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('passed');
    expect(executed).toBe(true);
  });

  it('still rejects arguments that violate the input schema', async () => {
    let executed = false;
    const runner = new AgentRunner({
      providers: new ProviderRegistry([
        adapter([
          {
            id: 'r1',
            output: [],
            toolCalls: [{ id: 'call', name: 'orders.get', arguments: { id: 'wrong' } }],
          },
        ]),
      ]),
      async resolveCredential() {
        return undefined;
      },
      async resolveTools() {
        return [typedTool(() => (executed = true))];
      },
    });
    const result = await runner.run({
      suite: agentSuite,
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
    });
    expect(executed).toBe(false);
    expect(result.error).toContain('invalid arguments for tool orders.get');
    expect(result.error).toContain('/id');
  });
});

describe('AgentSuiteRunner graders without eval', () => {
  it('grades json-schema and tool argument schemas', async () => {
    const graded = {
      ...agentSuite,
      tools: [],
      graders: [
        {
          id: 'schema-pass',
          kind: 'json-schema',
          schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        },
        {
          id: 'schema-fail',
          kind: 'json-schema',
          schema: { type: 'object', required: ['missing'] },
        },
        {
          id: 'tool',
          kind: 'tool',
          toolName: 'lookup',
          argumentsSchema: { type: 'object', required: ['id'] },
        },
      ],
    } as AgentSuite;
    const runner = new AgentSuiteRunner({
      async run(request): Promise<AgentRunResult> {
        return {
          status: 'passed',
          output: [{ type: 'text', text: '{"ok":true}' }],
          trace: {
            id: 'trace',
            suiteId: 'suite',
            taskId: 'task',
            trial: request.trial,
            agentId: 'agent',
            startedAt: 0,
            finishedAt: 10,
            events: [
              {
                id: 'tool-event',
                traceId: 'trace',
                sequence: 1,
                timestamp: 1,
                type: 'tool.requested',
                toolCallId: 'call',
                toolName: 'lookup',
                arguments: { id: 1 },
                permissionClass: 'read',
              },
            ],
          },
        };
      },
    });
    const report = await runner.run({ suite: graded });
    const scores = report.results[0]?.scores ?? [];
    expect(scores.map((s) => [s.graderId, s.passed])).toEqual([
      ['schema-pass', true],
      ['schema-fail', false],
      ['tool', true],
    ]);
    expect(scores[1]?.detail).toContain('missing');
    expect(scores[1]?.detail).not.toContain('JSON grading failed');
  });
});

describe('AI Lab scorers without eval', () => {
  const ctx = (over: Partial<ScorerContext> = {}): ScorerContext => ({
    output: '{"a":1}',
    testCase: { id: 'c', vars: {} },
    latencyMs: 1,
    cost: 0,
    ...over,
  });

  it('json-schema scorer passes and fails on structure', async () => {
    const s: ScorerConfig = {
      id: 's',
      kind: 'json-schema',
      schema: JSON.stringify({
        type: 'object',
        properties: { a: { type: 'number' } },
        required: ['a'],
      }),
    };
    expect(await runScorer(s, ctx())).toMatchObject({ passed: true });
    const failed = await runScorer(s, ctx({ output: '{"a":"x"}' }));
    expect(failed.passed).toBe(false);
    expect(failed.detail).not.toMatch(/schema validation error/);
  });

  it('tool-call scorer validates arguments against argsSchema', async () => {
    const s: ScorerConfig = {
      id: 's',
      kind: 'tool-call',
      expectedTool: 'fetch',
      argsSchema: JSON.stringify({ type: 'object', required: ['url'] }),
    };
    const ok = await runScorer(
      s,
      ctx({ toolCalls: [{ id: 'c1', name: 'fetch', input: '{"url":"https://x"}' }] })
    );
    expect(ok.passed).toBe(true);
    const bad = await runScorer(s, ctx({ toolCalls: [{ id: 'c1', name: 'fetch', input: '{}' }] }));
    expect(bad.passed).toBe(false);
    expect(bad.detail).not.toMatch(/schema validation error/);
  });
});

describe('contract validator without eval', () => {
  const spec = {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {
      '/u': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id'],
                    properties: { id: { type: 'integer' } },
                    additionalProperties: false,
                  },
                },
              },
            },
          },
        },
      },
    },
  } as unknown as AnyOpenAPISpec;
  const match: OperationMatch = {
    operationId: 'getU',
    pathTemplate: '/u',
    method: 'get',
    pathParams: {},
    operation: spec.paths!['/u']!.get!,
  };

  it.each(['draft-07', '2020-12'] as const)('validates a %s response body', async (dialect) => {
    const ok = await validateResponse({
      match,
      schemaDialect: dialect,
      status: 200,
      headers: {},
      body: { id: 1 },
    });
    expect(ok.valid).toBe(true);
    const bad = await validateResponse({
      match,
      schemaDialect: dialect,
      status: 200,
      headers: {},
      body: { id: 'x', extra: true },
    });
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e) => e.keyword)).toEqual(
      expect.arrayContaining(['type', 'additionalProperties'])
    );
    expect(bad.errors.find((e) => e.keyword === 'type')?.path).toBe('/id');
  });
});
