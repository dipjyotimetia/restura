import { describe, expect, it } from 'vitest';
import {
  AGENT_SUITE_SCHEMA_VERSION,
  AgentLimitsSchema,
  AgentSuiteSchema,
  migrateAgentSuite,
  TraceEventSchema,
} from '../schema';

describe('AgentSuiteSchema', () => {
  const model = { providerId: 'judge', model: 'model' };
  const suiteWithGrader = (grader: unknown) => ({
    schemaVersion: 2,
    id: 'judge-suite',
    name: 'Judge suite',
    mode: 'regression',
    agents: [
      {
        id: 'primary',
        model: { providerId: 'fake', model: 'model' },
        instructions: 'Run.',
        tools: [],
        limits: { maxSteps: 1, maxWallTimeMs: 1_000 },
      },
    ],
    tasks: [{ id: 'case', input: [{ type: 'text', text: 'hello' }] }],
    graders: [grader],
    trials: 1,
  });
  const judge = (overrides: Record<string, unknown> = {}) => ({
    id: 'judge',
    kind: 'judge',
    judgeModels: [model],
    rubric: 'Correctness',
    labels: ['pass', 'fail'],
    passingLabels: ['pass'],
    calibrated: false,
    ...overrides,
  });
  const anchor = (label: string, score: number) => ({
    input: 'input',
    output: label,
    label,
    score,
  });

  it.each([
    ['unknown passing label', judge({ passingLabels: ['maybe'] })],
    [
      'unknown anchor label',
      judge({ calibrated: true, anchors: [anchor('pass', 1), anchor('maybe', 0)] }),
    ],
    [
      'single-class anchors',
      judge({ calibrated: true, anchors: [anchor('pass', 0.9), anchor('pass', 1)] }),
    ],
    [
      'narrow score span',
      judge({ calibrated: true, anchors: [anchor('pass', 0.8), anchor('fail', 0.4)] }),
    ],
    ['duplicate model', judge({ judgeModels: [model, model] })],
    ['zero quorum', judge({ minimumQuorum: 0 })],
    ['oversized quorum', judge({ minimumQuorum: 2 })],
  ])('rejects %s', (_name, grader) => {
    expect(() => AgentSuiteSchema.parse(suiteWithGrader(grader))).toThrow();
  });

  it('accepts calibrated judges with diverse anchors and a valid quorum', () => {
    expect(() =>
      AgentSuiteSchema.parse(
        suiteWithGrader(
          judge({
            minimumQuorum: 1,
            calibrated: true,
            anchors: [anchor('pass', 0.9), anchor('fail', 0.3)],
          })
        )
      )
    ).not.toThrow();
  });

  it('rejects an explicitly empty task reference', () => {
    const candidate = suiteWithGrader({ id: 'reference', kind: 'exact' });
    Object.assign(candidate.tasks[0]!, { reference: [] });

    expect(() => AgentSuiteSchema.parse(candidate)).toThrow();
  });

  it.each([
    ['zero judge output tokens', judge({ maxOutputTokens: 0 })],
    ['negative judge panel cost', judge({ maxPanelCostUSD: -0.01 })],
  ])('rejects %s', (_name, grader) => {
    expect(() => AgentSuiteSchema.parse(suiteWithGrader(grader))).toThrow();
  });

  it('documents maxTokens as the total input and output budget for a run', () => {
    expect(AgentLimitsSchema.shape.maxTokens.description).toContain(
      'total input and output tokens across the run'
    );
  });

  it('accepts a versioned suite with environment credential references', () => {
    const parsed = AgentSuiteSchema.parse({
      schemaVersion: 2,
      id: 'support-agent',
      name: 'Support agent regression',
      mode: 'regression',
      agents: [
        {
          id: 'primary',
          model: {
            providerId: 'openai.responses',
            model: 'gpt-test',
            credential: { source: 'env', name: 'OPENAI_API_KEY' },
          },
          instructions: 'Resolve the request using the available tools.',
          tools: [],
          limits: { maxSteps: 12, maxWallTimeMs: 60_000 },
        },
      ],
      tasks: [{ id: 'case-1', input: [{ type: 'text', text: 'Check order 42' }] }],
      graders: [{ id: 'has-answer', kind: 'contains', value: 'order' }],
      trials: 3,
    });

    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.agents[0]?.model.providerId).toBe('openai.responses');
  });

  it('rejects unsupported schema versions', () => {
    expect(() =>
      AgentSuiteSchema.parse({
        schemaVersion: 1,
        id: 'legacy',
        name: 'Legacy',
        mode: 'regression',
        agents: [],
        tasks: [],
        graders: [],
        trials: 1,
      })
    ).toThrow();
  });

  it('migrates a v2 suite to v3 with explicit empty grounding', () => {
    const migrated = migrateAgentSuite({
      schemaVersion: 2,
      id: 'legacy',
      name: 'Legacy',
      mode: 'regression',
      agents: [
        {
          id: 'primary',
          model: { providerId: 'fake', model: 'model' },
          instructions: 'Run.',
          tools: [],
          limits: { maxSteps: 1, maxWallTimeMs: 1_000 },
        },
      ],
      tasks: [{ id: 'case', input: [{ type: 'text', text: 'hello' }] }],
      graders: [],
      trials: 1,
    });

    expect(migrated.schemaVersion).toBe(AGENT_SUITE_SCHEMA_VERSION);
    expect(migrated.grounding).toEqual({ sourceIds: [], maxBytes: 16_384 });
  });

  it('rejects duplicate grounding source ids', () => {
    const result = AgentSuiteSchema.safeParse({
      schemaVersion: 3,
      id: 'grounded',
      name: 'Grounded',
      mode: 'regression',
      agents: [
        {
          id: 'primary',
          model: { providerId: 'fake', model: 'model' },
          instructions: 'Run.',
          tools: [],
          limits: { maxSteps: 1, maxWallTimeMs: 1_000 },
        },
      ],
      tasks: [{ id: 'case', input: [{ type: 'text', text: 'hello' }] }],
      graders: [],
      trials: 1,
      grounding: { sourceIds: ['orders', 'orders'], maxBytes: 1_024 },
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('duplicate grounding source id');
  });

  it('rejects inline credential values', () => {
    const result = AgentSuiteSchema.safeParse({
      schemaVersion: 2,
      id: 'unsafe',
      name: 'Unsafe',
      mode: 'regression',
      agents: [
        {
          id: 'primary',
          model: {
            providerId: 'vendor.custom',
            model: 'model',
            credential: { source: 'inline', value: 'secret' },
          },
          instructions: 'Run.',
          tools: [],
          limits: { maxSteps: 1, maxWallTimeMs: 1_000 },
        },
      ],
      tasks: [{ id: 'case', input: [{ type: 'text', text: 'hello' }] }],
      graders: [],
      trials: 1,
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate ids and unknown handoff targets', () => {
    const result = AgentSuiteSchema.safeParse({
      schemaVersion: 2,
      id: 'duplicates',
      name: 'Duplicates',
      mode: 'regression',
      agents: [
        {
          id: 'primary',
          model: { providerId: 'fake', model: 'model' },
          instructions: 'Run.',
          tools: [],
          handoffs: ['missing'],
          limits: { maxSteps: 1, maxWallTimeMs: 1_000 },
        },
      ],
      tasks: [
        { id: 'case', input: [{ type: 'text', text: 'one' }] },
        { id: 'case', input: [{ type: 'text', text: 'two' }] },
      ],
      graders: [],
      trials: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('duplicate tasks id');
      expect(result.error.message).toContain('unknown handoff agent');
    }
  });
});

describe('TraceEventSchema', () => {
  it('parses a typed tool event without provider-specific fields', () => {
    const event = TraceEventSchema.parse({
      id: 'event-1',
      traceId: 'trace-1',
      sequence: 2,
      timestamp: 10,
      type: 'tool.completed',
      toolCallId: 'call-1',
      toolName: 'orders.get',
      output: [{ type: 'json', value: { id: 42, status: 'paid' } }],
      durationMs: 25,
    });

    expect(event.type).toBe('tool.completed');
  });

  it('parses evidence retrieval and policy decision events', () => {
    expect(
      TraceEventSchema.parse({
        id: 'event-2',
        traceId: 'trace-1',
        sequence: 3,
        timestamp: 11,
        type: 'context.retrieved',
        sourceId: 'orders-schema',
        kind: 'openapi',
        bytes: 128,
        truncated: false,
      })
    ).toMatchObject({ type: 'context.retrieved', sourceId: 'orders-schema' });
    expect(
      TraceEventSchema.parse({
        id: 'event-3',
        traceId: 'trace-1',
        sequence: 4,
        timestamp: 12,
        type: 'policy.decision',
        subject: 'orders.get',
        decision: 'allowed',
        reason: 'manifest read-only allowlist',
      })
    ).toMatchObject({ type: 'policy.decision', decision: 'allowed' });
  });
});
