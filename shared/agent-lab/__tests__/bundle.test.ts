import { describe, expect, it } from 'vitest';
import {
  createFixtureToolSourceAdapter,
  evaluateAgentBundleBaseline,
  AgentBundleSchema,
  resolveFixtureTools,
} from '../bundle';

const bundle = {
  schemaVersion: 1,
  id: 'orders-regression',
  name: 'Orders regression',
  suite: {
    schemaVersion: 2,
    id: 'orders-suite',
    name: 'Orders suite',
    mode: 'regression',
    agents: [
      {
        id: 'agent',
        model: { providerId: 'fake', model: 'model' },
        instructions: 'Use the order lookup tool.',
        tools: [{ kind: 'fixture', fixtureId: 'order-42' }],
        limits: { maxSteps: 2, maxWallTimeMs: 1_000 },
      },
    ],
    tasks: [{ id: 'find-order', input: [{ type: 'text', text: 'Find order 42' }] }],
    graders: [],
    trials: 1,
  },
  fixtures: [
    {
      id: 'order-42',
      tool: {
        name: 'orders_get',
        description: 'Read a single order.',
        inputSchema: { type: 'object', additionalProperties: false },
      },
      output: [{ type: 'json', value: { id: 42, status: 'paid' } }],
    },
  ],
  baseline: { minPassRate: 1, maxLatencyMs: 500 },
};

describe('AgentBundleSchema', () => {
  it('accepts a portable fixture-first bundle without credentials', () => {
    const parsed = AgentBundleSchema.parse(bundle);

    expect(parsed.fixtures[0]?.tool.name).toBe('orders_get');
    expect(parsed.suite.agents[0]?.tools).toEqual([{ kind: 'fixture', fixtureId: 'order-42' }]);
  });

  it('rejects desktop secret-handle credentials from a Git-native bundle', () => {
    const candidate = structuredClone(bundle) as {
      suite: { agents: Array<{ model: Record<string, unknown> }> };
    };
    candidate.suite.agents[0]!.model.credential = {
      source: 'secret-handle',
      id: '00000000-0000-4000-8000-000000000001',
    };

    expect(() => AgentBundleSchema.parse(candidate)).toThrow(/secret-handle/i);
  });

  it('fails a baseline when the report regresses on pass rate and latency', () => {
    const parsed = AgentBundleSchema.parse(bundle);
    const gates = evaluateAgentBundleBaseline(parsed, {
      suiteId: 'orders-suite',
      status: 'failed',
      results: [
        {
          taskId: 'find-order',
          agentId: 'agent',
          trial: 1,
          status: 'failed',
          output: [],
          scores: [],
          trace: {
            id: 'trace',
            suiteId: 'orders-suite',
            taskId: 'find-order',
            trial: 1,
            agentId: 'agent',
            startedAt: 0,
            finishedAt: 750,
            events: [],
          },
        },
      ],
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        errors: 0,
        cancelled: 0,
        passRate: 0,
        confidence95: { low: 0, high: 0 },
        passAtK: { '1': 0 },
        passToK: { '1': 0 },
        reliabilityByCase: [],
      },
    });

    expect(gates).toEqual([
      { metric: 'passRate', expected: 1, actual: 0, passed: false },
      { metric: 'maxLatencyMs', expected: 500, actual: 750, passed: false },
    ]);
  });

  it('resolves fixture tools without granting live-network permissions', async () => {
    const parsed = AgentBundleSchema.parse(bundle);
    const [tool] = resolveFixtureTools(parsed.suite.agents[0]!.tools, parsed.fixtures);

    expect(tool?.permissionClass).toBe('read');
    await expect(tool?.execute({}, { signal: new AbortController().signal })).resolves.toEqual([
      { type: 'json', value: { id: 42, status: 'paid' } },
    ]);
  });

  it('exposes fixtures through the shared tool-source adapter port', async () => {
    const parsed = AgentBundleSchema.parse(bundle);
    const adapter = createFixtureToolSourceAdapter(parsed.fixtures);

    await expect(
      adapter.resolve({ kind: 'fixture', fixtureId: 'order-42' })
    ).resolves.toMatchObject([{ definition: { name: 'orders_get' }, permissionClass: 'read' }]);
  });

  it('rejects fixture calls whose arguments do not match the recorded scenario', async () => {
    const candidate = structuredClone(bundle) as {
      fixtures: Array<{ expectedArguments?: unknown }>;
    };
    candidate.fixtures[0]!.expectedArguments = { id: 42 };
    const parsed = AgentBundleSchema.parse(candidate);
    const [tool] = resolveFixtureTools(parsed.suite.agents[0]!.tools, parsed.fixtures);

    await expect(
      tool?.execute({ id: 41 }, { signal: new AbortController().signal })
    ).rejects.toThrow(/arguments did not match/i);
  });
});
