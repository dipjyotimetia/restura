import type { AgentSuite } from '@shared/agent-lab';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopAgentProviders, runDesktopAgentSuite } from '../agentRuntime';

const completeLlm = vi.fn();

beforeEach(() => {
  completeLlm.mockReset();
});

function provider(id: string, model: string) {
  return {
    id,
    provider: 'openai-compatible' as const,
    label: id,
    pricingKnown: false,
    isLocal: true,
    models: [model],
    capabilityOverrides: {
      [model]: {
        inputModalities: ['text' as const],
        outputModalities: ['text' as const],
        structuredOutput: true,
        toolCalling: false,
        parallelToolCalls: false,
        reasoning: false,
        continuation: false,
        serverTools: [],
      },
    },
    createdAt: 0,
  };
}

describe('desktop agent provider bridge', () => {
  it('retains successful judge votes, records failures, and includes full task context', async () => {
    const prompts: string[] = [];
    completeLlm.mockImplementation(
      async (spec: { model: string; messages: Array<{ content: string }> }) => {
        if (spec.model === 'candidate') {
          return { ok: true, text: 'candidate output', toolCalls: [] };
        }
        prompts.push(spec.messages[0]!.content);
        if (spec.model === 'judge-2') {
          return { ok: false, text: '', toolCalls: [], error: { message: 'timeout' } };
        }
        return {
          ok: true,
          text: JSON.stringify({ label: 'pass', score: 0.9, reasoning: 'correct' }),
          toolCalls: [],
        };
      }
    );
    const suite: AgentSuite = {
      schemaVersion: 2,
      id: 'suite',
      name: 'Judge isolation',
      mode: 'regression',
      agents: [
        {
          id: 'agent',
          model: { providerId: 'candidate', model: 'candidate' },
          instructions: 'Answer.',
          tools: [],
          limits: { maxSteps: 1, maxWallTimeMs: 1_000 },
        },
      ],
      tasks: [
        {
          id: 'task',
          input: [{ type: 'text', text: 'task input' }],
          reference: [{ type: 'text', text: 'task reference' }],
        },
      ],
      graders: [
        {
          id: 'judge',
          kind: 'judge',
          judgeModels: [
            { providerId: 'judge-1', model: 'judge-1' },
            { providerId: 'judge-2', model: 'judge-2' },
            { providerId: 'judge-3', model: 'judge-3' },
          ],
          rubric: 'Use the reference.',
          labels: ['pass', 'fail'],
          passingLabels: ['pass'],
          minimumAgreement: 0.5,
          calibrated: false,
        },
      ],
      trials: 1,
    };

    const report = await runDesktopAgentSuite(
      suite,
      {
        candidate: provider('candidate', 'candidate'),
        'judge-1': provider('judge-1', 'judge-1'),
        'judge-2': provider('judge-2', 'judge-2'),
        'judge-3': provider('judge-3', 'judge-3'),
      },
      { complete: completeLlm }
    );

    expect(report.results[0]?.scores[0]).toMatchObject({
      passed: true,
      detail: expect.stringContaining('2/3 judges succeeded'),
      judgeFailures: [{ providerId: 'judge-2', error: 'timeout' }],
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('Task input: task input');
    expect(prompts[0]).toContain('Reference: task reference');
    expect(prompts[0]).toContain('Candidate output: candidate output');
    expect(prompts[0]).toContain('Rubric: Use the reference.');
    expect(prompts[0]).toContain('Allowed labels: pass, fail');
    expect(prompts[0]).toContain('Response schema:');
  });

  it('fails only the judge grader when successful votes do not meet quorum', async () => {
    completeLlm.mockImplementation(async (spec: { model: string }) => {
      if (spec.model === 'candidate') {
        return { ok: true, text: 'literal candidate', toolCalls: [] };
      }
      if (spec.model === 'judge-1') {
        return {
          ok: true,
          text: JSON.stringify({ label: 'pass', score: 0.9 }),
          toolCalls: [],
        };
      }
      return { ok: false, text: '', toolCalls: [], error: { message: 'offline' } };
    });
    const suite: AgentSuite = {
      schemaVersion: 2,
      id: 'suite',
      name: 'Judge quorum',
      mode: 'regression',
      agents: [
        {
          id: 'agent',
          model: { providerId: 'candidate', model: 'candidate' },
          instructions: 'Answer.',
          tools: [],
          limits: { maxSteps: 1, maxWallTimeMs: 1_000 },
        },
      ],
      tasks: [{ id: 'task', input: [{ type: 'text', text: 'task input' }] }],
      graders: [
        { id: 'literal', kind: 'contains', value: 'literal' },
        {
          id: 'judge',
          kind: 'judge',
          judgeModels: [
            { providerId: 'judge-1', model: 'judge-1' },
            { providerId: 'judge-2', model: 'judge-2' },
            { providerId: 'judge-3', model: 'judge-3' },
          ],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          passingLabels: ['pass'],
          minimumQuorum: 2,
          minimumAgreement: 0.5,
          calibrated: false,
        },
      ],
      trials: 1,
    };

    const report = await runDesktopAgentSuite(
      suite,
      {
        candidate: provider('candidate', 'candidate'),
        'judge-1': provider('judge-1', 'judge-1'),
        'judge-2': provider('judge-2', 'judge-2'),
        'judge-3': provider('judge-3', 'judge-3'),
      },
      { complete: completeLlm }
    );

    expect(report.results[0]?.scores).toEqual([
      expect.objectContaining({ graderId: 'literal', passed: true }),
      expect.objectContaining({
        graderId: 'judge',
        passed: false,
        detail: expect.stringContaining('insufficient judge quorum'),
      }),
    ]);
  });

  it('adapts existing keychain-backed AI Lab providers to the shared runner', async () => {
    const registry = createDesktopAgentProviders(
      {
        cfg: {
          id: 'cfg',
          provider: 'anthropic',
          label: 'Claude',
          pricingKnown: true,
          isLocal: false,
          models: ['claude'],
          createdAt: 0,
          apiKeyHandleId: 'handle',
        },
      },
      async () => ({
        ok: true,
        text: 'done',
        toolCalls: [{ id: 'call', name: 'lookup', input: '{"id":1}' }],
        usage: { promptTokens: 3, completionTokens: 2, estimatedCostUSD: 0.01 },
      })
    );
    const response = await registry.require('cfg').generate(
      {
        model: { providerId: 'cfg', model: 'claude' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      },
      {
        async resolveCredential() {
          return undefined;
        },
      }
    );
    expect(response).toMatchObject({
      output: [{ type: 'text', text: 'done' }],
      toolCalls: [{ name: 'lookup', arguments: { id: 1 } }],
    });
  });

  it('exposes conservative capabilities for unknown models', async () => {
    const registry = createDesktopAgentProviders({
      cfg: {
        id: 'cfg',
        provider: 'openai-compatible',
        label: 'Gateway',
        pricingKnown: false,
        isLocal: true,
        models: ['custom'],
        createdAt: 0,
      },
    });

    await expect(registry.require('cfg').getCapabilities('custom')).resolves.toMatchObject({
      inputModalities: ['text'],
      toolCalling: false,
      structuredOutput: false,
      reasoning: false,
      continuation: false,
    });
  });

  it('refuses a stale override for a model absent from the provider catalog', async () => {
    const registry = createDesktopAgentProviders({
      cfg: {
        id: 'cfg',
        provider: 'openai-compatible',
        label: 'Gateway',
        pricingKnown: false,
        isLocal: true,
        models: [],
        capabilityOverrides: {
          custom: {
            inputModalities: ['text'],
            outputModalities: ['text'],
            structuredOutput: false,
            toolCalling: true,
            parallelToolCalls: false,
            reasoning: false,
            continuation: false,
            serverTools: [],
          },
        },
        createdAt: 0,
      },
    });

    await expect(registry.require('cfg').getCapabilities('custom')).resolves.toMatchObject({
      toolCalling: false,
      parallelToolCalls: false,
    });
  });

  it('omits cost when the selected model has no exact known pricing', async () => {
    const registry = createDesktopAgentProviders(
      {
        cfg: {
          id: 'cfg',
          provider: 'openai-compatible',
          label: 'Gateway',
          pricingKnown: false,
          isLocal: true,
          models: ['custom'],
          createdAt: 0,
        },
      },
      async () => ({
        ok: true,
        text: 'done',
        toolCalls: [],
        usage: { promptTokens: 3, completionTokens: 2, estimatedCostUSD: 0 },
      })
    );

    const response = await registry.require('cfg').generate(
      {
        model: { providerId: 'cfg', model: 'custom' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      },
      {
        async resolveCredential() {
          return undefined;
        },
      }
    );

    expect(response.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(response.costUSD).toBeUndefined();
  });
});
