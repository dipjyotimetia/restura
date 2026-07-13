import { describe, expect, it } from 'vitest';
import { AgentLimitsSchema, AgentSuiteSchema, TraceEventSchema } from '../schema';

describe('AgentSuiteSchema', () => {
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
});
