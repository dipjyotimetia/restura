import { beforeEach, describe, expect, it } from 'vitest';
import { useAiLabStore } from '../useAiLabStore';

describe('AI Lab agent suites', () => {
  beforeEach(() => useAiLabStore.setState({ agentSuites: {} }));

  it('validates and persists versioned suites', () => {
    const suite = {
      schemaVersion: 2 as const,
      id: 'suite',
      name: 'Agent suite',
      mode: 'regression' as const,
      agents: [
        {
          id: 'agent',
          model: { providerId: 'openai.responses', model: 'gpt' },
          instructions: 'Help',
          tools: [],
          limits: { maxSteps: 4, maxWallTimeMs: 10_000 },
        },
      ],
      tasks: [{ id: 'task', input: [{ type: 'text' as const, text: 'Hello' }] }],
      graders: [],
      trials: 1,
    };
    useAiLabStore.getState().upsertAgentSuite(suite);
    expect(useAiLabStore.getState().agentSuites.suite).toEqual(suite);
    useAiLabStore.getState().removeAgentSuite('suite');
    expect(useAiLabStore.getState().agentSuites.suite).toBeUndefined();
  });

  it('rejects invalid suite data at the store boundary', () => {
    expect(() => useAiLabStore.getState().upsertAgentSuite({ schemaVersion: 1 })).toThrow();
  });
});
