import type { AgentSuite } from '@shared/agent-lab';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiLabProviderConfig } from '../../types';
import { createDesktopAgentProviders, runDesktopAgentSuite } from '../agentRuntime';

const completeLlm = vi.fn();

beforeEach(() => {
  completeLlm.mockReset();
});

function provider(
  id: string,
  model: string | string[],
  pricing?: { promptPerMTokUSD: number; completionPerMTokUSD: number }
): AiLabProviderConfig {
  const models = Array.isArray(model) ? model : [model];
  return {
    id,
    provider: 'openai-compatible' as const,
    label: id,
    pricingKnown: false,
    isLocal: true,
    models,
    capabilityOverrides: Object.fromEntries(
      models.map((modelId) => [
        modelId,
        {
          inputModalities: ['text' as const],
          outputModalities: ['text' as const],
          structuredOutput: true,
          toolCalling: false,
          parallelToolCalls: false,
          reasoning: false,
          continuation: false,
          serverTools: [],
        },
      ])
    ),
    ...(pricing
      ? { modelDetails: Object.fromEntries(models.map((modelId) => [modelId, { pricing }])) }
      : {}),
    createdAt: 0,
  };
}

describe('desktop agent provider bridge', () => {
  it.each([
    [
      'media input',
      {
        messages: [
          {
            role: 'user' as const,
            content: [{ type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }],
          },
        ],
      },
      'image input',
    ],
    [
      'structured output',
      {
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
        structuredOutput: { type: 'object' },
      },
      'structured output',
    ],
    [
      'reasoning controls',
      {
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
        reasoning: { effort: 'high' as const },
      },
      'reasoning controls',
    ],
    [
      'continuation',
      {
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }],
        continuationId: 'opaque-state',
      },
      'continuation',
    ],
  ])(
    'rejects unsupported %s before calling the Electron completion transport',
    async (_label, patch, message) => {
      const registry = createDesktopAgentProviders({ cfg: provider('cfg', 'model') }, completeLlm);
      const adapter = registry.require('cfg');

      await expect(
        adapter.generate(
          {
            model: { providerId: 'cfg', model: 'model' },
            ...patch,
          },
          {
            async resolveCredential() {
              return undefined;
            },
          }
        )
      ).rejects.toThrow(message);
      expect(completeLlm).not.toHaveBeenCalled();
    }
  );

  it('retains successful judge votes, records failures, and includes full task context', async () => {
    const prompts: string[] = [];
    const judgeMaxOutputTokens: Array<number | undefined> = [];
    completeLlm.mockImplementation(
      async (spec: { model: string; messages: Array<{ content: string }> }) => {
        if (spec.model === 'candidate') {
          return { ok: true, text: 'candidate output', toolCalls: [] };
        }
        prompts.push(spec.messages[0]!.content);
        judgeMaxOutputTokens.push((spec as { maxOutputTokens?: number }).maxOutputTokens);
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
      resourceCalls: { attempted: 3, usageKnown: 0, costKnown: 0 },
      judgeFailures: [{ providerId: 'judge-2', model: 'judge-2', error: 'timeout' }],
      judgeVotes: expect.arrayContaining([
        expect.objectContaining({ providerId: 'judge-1', model: 'judge-1' }),
        expect.objectContaining({ providerId: 'judge-3', model: 'judge-3' }),
      ]),
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('Task input: task input');
    expect(prompts[0]).toContain('Reference: task reference');
    expect(prompts[0]).toContain('Candidate output: candidate output');
    expect(prompts[0]).toContain('Rubric: Use the reference.');
    expect(prompts[0]).toContain('Allowed labels: pass, fail');
    expect(prompts[0]).toContain('Response schema:');
    expect(judgeMaxOutputTokens).toEqual([512, 512, 512]);
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

  it('identifies votes and failures by model when judges share a provider', async () => {
    completeLlm.mockImplementation(async (spec: { model: string }) => {
      if (spec.model === 'candidate') {
        return { ok: true, text: 'candidate', toolCalls: [] };
      }
      if (spec.model === 'judge-b') {
        return { ok: false, text: '', toolCalls: [], error: { message: 'unavailable' } };
      }
      return {
        ok: true,
        text: JSON.stringify({ label: 'pass', score: 0.8 }),
        toolCalls: [],
      };
    });
    const suite: AgentSuite = {
      schemaVersion: 2,
      id: 'identity',
      name: 'Judge identity',
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
      tasks: [{ id: 'task', input: [{ type: 'text', text: 'input' }] }],
      graders: [
        {
          id: 'judge',
          kind: 'judge',
          judgeModels: [
            { providerId: 'shared', model: 'judge-a' },
            { providerId: 'shared', model: 'judge-b' },
          ],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          minimumQuorum: 1,
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
        shared: provider('shared', ['judge-a', 'judge-b']),
      },
      { complete: completeLlm }
    );

    expect(report.results[0]?.scores[0]).toMatchObject({
      judgeVotes: [expect.objectContaining({ providerId: 'shared', model: 'judge-a' })],
      judgeFailures: [{ providerId: 'shared', model: 'judge-b', error: 'unavailable' }],
    });
  });

  it('cancels paid calibration calls and does not start later graders', async () => {
    const controller = new AbortController();
    const judgeCalls: string[] = [];
    const judgeSignals: AbortSignal[] = [];
    completeLlm.mockImplementation(
      async (spec: { model: string }, options?: { signal?: AbortSignal }) => {
        if (spec.model === 'candidate') {
          return { ok: true, text: 'candidate', toolCalls: [] };
        }
        judgeCalls.push(spec.model);
        if (!options?.signal) throw new Error('judge signal missing');
        judgeSignals.push(options.signal);
        return new Promise((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException('cancelled', 'AbortError'));
          if (options.signal!.aborted) {
            rejectAbort();
            return;
          }
          options.signal!.addEventListener('abort', rejectAbort, { once: true });
          controller.abort();
        });
      }
    );
    const suite: AgentSuite = {
      schemaVersion: 2,
      id: 'cancel',
      name: 'Cancellation',
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
      tasks: [{ id: 'task', input: [{ type: 'text', text: 'input' }] }],
      graders: [
        {
          id: 'calibrated',
          kind: 'judge',
          judgeModels: [{ providerId: 'judges', model: 'calibration-judge' }],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          passingLabels: ['pass'],
          anchors: [
            { input: 'pass input', output: 'pass output', label: 'pass', score: 0.9 },
            { input: 'fail input', output: 'fail output', label: 'fail', score: 0.1 },
          ],
          minimumAgreement: 0.5,
          calibrated: true,
        },
        {
          id: 'later',
          kind: 'judge',
          judgeModels: [{ providerId: 'judges', model: 'later-judge' }],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          minimumAgreement: 0.5,
          calibrated: false,
        },
      ],
      trials: 1,
    };
    const options = { complete: completeLlm, signal: controller.signal };

    const report = await runDesktopAgentSuite(
      suite,
      {
        candidate: provider('candidate', 'candidate'),
        judges: provider('judges', ['calibration-judge', 'later-judge']),
      },
      options
    );

    expect(judgeSignals.length).toBeGreaterThan(0);
    expect(judgeSignals.every((signal) => signal === controller.signal)).toBe(true);
    expect(judgeCalls).not.toContain('later-judge');
    expect(report.status).toBe('cancelled');
  });

  it('bounds judge output and aggregates calibration usage and cost before enforcing the panel cap', async () => {
    const judgeSpecs: Array<{ maxOutputTokens?: number; messages: Array<{ content: string }> }> =
      [];
    completeLlm.mockImplementation(
      async (spec: {
        model: string;
        maxOutputTokens?: number;
        messages: Array<{ content: string }>;
      }) => {
        if (spec.model === 'candidate') {
          return { ok: true, text: 'candidate', toolCalls: [] };
        }
        judgeSpecs.push(spec);
        const prompt = spec.messages[0]!.content;
        const failAnchor = prompt.includes('Candidate output: fail output');
        return {
          ok: true,
          text: JSON.stringify({
            label: failAnchor ? 'fail' : 'pass',
            score: failAnchor ? 0.1 : 0.9,
          }),
          toolCalls: [],
          usage: { promptTokens: 2, completionTokens: 1, estimatedCostUSD: 0 },
        };
      }
    );
    const suite: AgentSuite = {
      schemaVersion: 2,
      id: 'resources',
      name: 'Judge resources',
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
      tasks: [{ id: 'task', input: [{ type: 'text', text: 'input' }] }],
      graders: [
        {
          id: 'judge',
          kind: 'judge',
          judgeModels: [{ providerId: 'judge', model: 'judge' }],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          passingLabels: ['pass'],
          anchors: [
            { input: 'pass input', output: 'pass output', label: 'pass', score: 0.9 },
            { input: 'fail input', output: 'fail output', label: 'fail', score: 0.1 },
          ],
          minimumAgreement: 0.5,
          calibrated: true,
          maxOutputTokens: 64,
          maxPanelCostUSD: 0.000008,
        },
      ],
      trials: 1,
    };

    const report = await runDesktopAgentSuite(
      suite,
      {
        candidate: provider('candidate', 'candidate'),
        judge: provider('judge', 'judge', {
          promptPerMTokUSD: 1,
          completionPerMTokUSD: 1,
        }),
      },
      { complete: completeLlm }
    );

    expect(judgeSpecs).toHaveLength(3);
    expect(judgeSpecs.every((spec) => spec.maxOutputTokens === 64)).toBe(true);
    expect(report.results[0]?.scores[0]).toMatchObject({
      passed: false,
      detail: expect.stringContaining('judge panel cost exceeded'),
      usage: { inputTokens: 6, outputTokens: 3 },
      costUSD: 0.000009,
    });
  });

  it('fails closed when a configured judge panel cost cap cannot be enforced', async () => {
    completeLlm.mockImplementation(async (spec: { model: string }) => ({
      ok: true,
      text:
        spec.model === 'candidate' ? 'candidate' : JSON.stringify({ label: 'pass', score: 0.9 }),
      toolCalls: [],
      usage: { promptTokens: 2, completionTokens: 1, estimatedCostUSD: 0 },
    }));
    const suite: AgentSuite = {
      schemaVersion: 2,
      id: 'unknown-cost',
      name: 'Unknown judge cost',
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
      tasks: [{ id: 'task', input: [{ type: 'text', text: 'input' }] }],
      graders: [
        {
          id: 'judge',
          kind: 'judge',
          judgeModels: [{ providerId: 'judge', model: 'judge' }],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          minimumAgreement: 0.5,
          calibrated: false,
          maxPanelCostUSD: 1,
        },
      ],
      trials: 1,
    };

    const report = await runDesktopAgentSuite(
      suite,
      {
        candidate: provider('candidate', 'candidate'),
        judge: provider('judge', 'judge'),
      },
      { complete: completeLlm }
    );

    expect(report.results[0]?.scores[0]).toMatchObject({
      passed: false,
      detail: expect.stringContaining('judge panel cost unknown'),
      usage: { inputTokens: 2, outputTokens: 1 },
    });
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
