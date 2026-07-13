import { Server } from 'node:net';
import type { AgentSuite, AgentSuiteReport } from '@shared/agent-lab';
import type { Fetcher } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';
import {
  agentEvalExitCode,
  evaluateAgentSuite,
  preflightAgentSuite,
  type AgentEvalDependencies,
} from '../agent';

function suite(
  overrides: {
    providerId?: string;
    baseUrl?: string;
    tools?: AgentSuite['agents'][number]['tools'];
    credential?: AgentSuite['agents'][number]['model']['credential'];
    graders?: AgentSuite['graders'];
  } = {}
): AgentSuite {
  return {
    schemaVersion: 2,
    id: 'cli-suite',
    name: 'CLI suite',
    mode: 'regression',
    agents: [
      {
        id: 'agent-1',
        model: {
          providerId: overrides.providerId ?? 'openai.responses',
          model: 'gpt-5-mini',
          ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
          ...(overrides.credential ? { credential: overrides.credential } : {}),
        },
        instructions: 'Answer succinctly.',
        tools: overrides.tools ?? [],
        limits: { maxSteps: 1, maxWallTimeMs: 1_000 },
      },
    ],
    tasks: [
      {
        id: 'task-1',
        input: [{ type: 'text', text: 'Say hello' }],
        reference: [{ type: 'text', text: 'hello' }],
      },
    ],
    graders: overrides.graders ?? [{ id: 'exact-1', kind: 'exact' }],
    trials: 1,
  };
}

function report(status: AgentSuiteReport['status']): AgentSuiteReport {
  const passed = status === 'passed' ? 1 : 0;
  return {
    suiteId: 'cli-suite',
    status,
    results: [],
    summary: {
      total: 1,
      passed,
      failed: status === 'failed' ? 1 : 0,
      errors: status === 'error' ? 1 : 0,
      cancelled: status === 'cancelled' ? 1 : 0,
      passRate: passed,
      confidence95: { low: 0, high: 1 },
      passAtK: { 1: passed },
      passToK: { 1: passed },
      reliabilityByCase: [],
    },
  };
}

function dependencies(
  input: unknown,
  fetcher: Fetcher,
  writeText = vi.fn()
): AgentEvalDependencies {
  return {
    readText: vi.fn().mockResolvedValue(JSON.stringify(input)),
    writeText,
    fetcher,
    environment: {},
  };
}

describe('preflightAgentSuite', () => {
  it.each([
    ['provider', suite({ providerId: 'anthropic' }), /adapter not registered/],
    ['base URL', suite({ baseUrl: 'https://gateway.example' }), /baseUrl overrides/],
    [
      'tool',
      suite({ tools: [{ kind: 'restura-request', requestId: 'request-1' }] }),
      /tool adapter/,
    ],
    [
      'judge',
      suite({
        graders: [
          {
            id: 'judge-1',
            kind: 'judge',
            judgeModels: [{ providerId: 'openai.responses', model: 'gpt-5-mini' }],
            rubric: 'Correctness',
            labels: ['pass', 'fail'],
            passingLabels: ['pass'],
            minimumAgreement: 0.5,
            calibrated: false,
          },
        ],
      }),
      /judge adapter/,
    ],
    [
      'secret handle',
      suite({
        credential: {
          source: 'secret-handle',
          id: '00000000-0000-4000-8000-000000000001',
        },
      }),
      /desktop keychain/,
    ],
  ])('rejects unsupported %s without I/O', async (_name, input, pattern) => {
    const fetcher = vi.fn<Fetcher>();
    const deps = dependencies(input, fetcher);

    await expect(evaluateAgentSuite('/suite.json', {}, deps)).rejects.toThrow(pattern);
    expect(fetcher).not.toHaveBeenCalled();
    expect(deps.writeText).not.toHaveBeenCalled();
  });

  it('is a pure validation boundary', () => {
    expect(() => preflightAgentSuite(suite())).not.toThrow();
    expect(() => preflightAgentSuite(suite({ providerId: 'ollama' }))).toThrow(
      /adapter not registered/
    );
  });
});

describe('evaluateAgentSuite', () => {
  it.each([
    ['invalid JSON', '{', /JSON/],
    ['invalid suite schema', { schemaVersion: 1 }, /schemaVersion/],
  ])('rejects %s before fetch', async (_name, input, pattern) => {
    const fetcher = vi.fn<Fetcher>();
    const deps = dependencies(input, fetcher);
    if (typeof input === 'string') {
      vi.mocked(deps.readText).mockResolvedValue(input);
    }

    await expect(evaluateAgentSuite('/suite.json', {}, deps)).rejects.toThrow(pattern);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('runs directly through injected dependencies and writes the report', async () => {
    const responseBody = JSON.stringify({
      id: 'response-1',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
      usage: { input_tokens: 4, output_tokens: 1 },
    });
    const fetcher = vi.fn<Fetcher>().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      contentLengthHeader: null,
      text: async () => responseBody,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const deps = dependencies(suite(), fetcher, writeText);
    const listen = vi.spyOn(Server.prototype, 'listen');
    const nativeFetch = vi.spyOn(globalThis, 'fetch');

    try {
      const result = await evaluateAgentSuite('/suite.json', { output: '/report.json' }, deps);

      expect(result.status).toBe('passed');
      expect(writeText).toHaveBeenCalledWith('/report.json', expect.stringContaining('"summary"'));
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(nativeFetch).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
    } finally {
      nativeFetch.mockRestore();
      listen.mockRestore();
    }
  });
});

describe('agentEvalExitCode', () => {
  it('maps passed, non-passed, and command errors to 0, 1, and 2', () => {
    expect(agentEvalExitCode(report('passed'))).toBe(0);
    expect(agentEvalExitCode(report('failed'))).toBe(1);
    expect(agentEvalExitCode(report('error'))).toBe(1);
    expect(agentEvalExitCode(report('cancelled'))).toBe(1);
    expect(agentEvalExitCode(new Error('invalid suite'))).toBe(2);
  });
});
