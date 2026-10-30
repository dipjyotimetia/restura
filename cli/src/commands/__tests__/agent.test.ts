import { Server } from 'node:net';
import {
  type AgentBundle,
  type AgentSuite,
  type AgentSuiteReport,
  createAgentToolResolver,
  createFixtureToolSourceAdapter,
} from '@shared/agent-lab';
import type { Fetcher } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';
import { connectCliMcpClient } from '../../runner/agentMcpClient';
import {
  type AgentEvalDependencies,
  agentBundleExitCode,
  agentEvalExitCode,
  evaluateAgentBundle,
  evaluateAgentSuite,
  preflightAgentSuite,
  runAgentEval,
} from '../agent';
import { AgentRuntimeManifestSchema } from '../agentRuntime';

vi.mock('../../runner/agentMcpClient', () => ({ connectCliMcpClient: vi.fn() }));

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
    loadEnvironment: vi.fn().mockResolvedValue({}),
    loadCollection: vi.fn(),
    executeHttp: vi.fn(),
  };
}

describe('preflightAgentSuite', () => {
  it.each([
    ['provider', suite({ providerId: 'unsupported' }), /adapter not registered/],
    ['base URL', suite({ baseUrl: 'https://gateway.example' }), /baseUrl overrides/],
    [
      'tool',
      suite({ tools: [{ kind: 'restura-request', requestId: 'request-1' }] }),
      /runtime manifest/,
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
    expect(() => preflightAgentSuite(suite({ providerId: 'anthropic.messages' }))).not.toThrow();
    expect(() => preflightAgentSuite(suite({ providerId: 'ollama' }))).toThrow(
      /adapter not registered/
    );
  });

  it('permits a saved request tool only when the runtime manifest explicitly owns it', () => {
    const runtime = AgentRuntimeManifestSchema.parse({
      schemaVersion: 1,
      sources: [
        {
          id: 'orders',
          kind: 'collection',
          path: './orders',
          requestIds: ['request-1'],
        },
      ],
    });

    expect(() =>
      preflightAgentSuite(
        suite({ tools: [{ kind: 'restura-request', requestId: 'request-1' }] }),
        createAgentToolResolver(),
        runtime
      )
    ).not.toThrow();
    expect(() =>
      preflightAgentSuite(
        suite({ tools: [{ kind: 'restura-request', requestId: 'request-2' }] }),
        createAgentToolResolver(),
        runtime
      )
    ).toThrow('not listed in the runtime manifest');
  });

  it('uses the supplied resolver port to admit fixture tools', () => {
    const resolver = createAgentToolResolver([createFixtureToolSourceAdapter([])]);

    expect(() =>
      preflightAgentSuite(suite({ tools: [{ kind: 'fixture', fixtureId: 'fixture-1' }] }), resolver)
    ).not.toThrow();
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

/** Dependencies serving a suite and runtime manifest by path. */
function dependenciesWithFiles(files: Record<string, unknown>, fetcher: Fetcher) {
  const deps = dependencies({}, fetcher);
  vi.mocked(deps.readText).mockImplementation(async (path) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return JSON.stringify(files[path]);
  });
  return deps;
}

type PolicyProfile = NonNullable<AgentSuite['policies']>[number];

function suiteWithPolicy(policy: Pick<PolicyProfile, 'autoApprove' | 'ciEligible'>): AgentSuite {
  const base = suite();
  return {
    ...base,
    policies: [{ id: 'policy-1', name: 'Policy', version: 1, ...policy }],
    agents: base.agents.map((agent) => ({ ...agent, policyId: 'policy-1' })),
  };
}

describe('policy profile CI gating', () => {
  it.each([
    ['not ciEligible', { autoApprove: [], ciEligible: false }],
    ['auto-approving mutations', { autoApprove: ['mutation'], ciEligible: true }],
  ])('exits 2 for a %s profile before any model call', async (_name, policy) => {
    const fetcher = vi.fn<Fetcher>();
    const deps = dependenciesWithFiles({ '/suite.json': suiteWithPolicy(policy) }, fetcher);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(await runAgentEval('/suite.json', {}, deps)).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ciEligible'));
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('admits a ciEligible read-only profile and suites with no profile', () => {
    expect(() =>
      preflightAgentSuite(suiteWithPolicy({ autoApprove: ['read'], ciEligible: true }))
    ).not.toThrow();
    expect(() => preflightAgentSuite(suite())).not.toThrow();
  });
});

describe('handoff preflight', () => {
  it('exits 2 before any model call when an agent declares handoffs', async () => {
    const base = suite();
    const agent = base.agents[0]!;
    const withHandoffs: AgentSuite = {
      ...base,
      agents: [
        { ...agent, handoffs: ['agent-2'] },
        { ...agent, id: 'agent-2' },
      ],
    };
    const fetcher = vi.fn<Fetcher>();
    const deps = dependenciesWithFiles({ '/suite.json': withHandoffs }, fetcher);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(await runAgentEval('/suite.json', {}, deps)).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('handoffs'));
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('scripted saved-request preflight', () => {
  it('exits 2 before any model call when a listed request has scripts', async () => {
    const fetcher = vi.fn<Fetcher>();
    const deps = dependenciesWithFiles(
      {
        '/suite.json': suite({ tools: [{ kind: 'restura-request', requestId: 'get-orders' }] }),
        '/runtime.json': {
          schemaVersion: 1,
          sources: [
            { id: 'orders', kind: 'collection', path: './orders', requestIds: ['get-orders'] },
          ],
        },
      },
      fetcher
    );
    vi.mocked(deps.loadCollection).mockResolvedValue({
      requests: [
        {
          relativePath: 'get-orders',
          folderPath: [],
          type: 'http',
          request: { id: 'get-orders', method: 'GET', testScript: 'pm.test("x", () => {})' },
        },
      ],
    } as Awaited<ReturnType<AgentEvalDependencies['loadCollection']>>);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(await runAgentEval('/suite.json', { runtime: '/runtime.json' }, deps)).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('script'));
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('runAgentEval exit codes', () => {
  const mcpRuntime = {
    schemaVersion: 1,
    sources: [
      {
        id: 'docs',
        kind: 'mcp',
        url: 'https://mcp.example.test/mcp',
        transport: 'streamable-http',
        readOnly: true,
        allowedTools: ['drop_table'],
      },
    ],
  };

  it('exits 2 before any model call when a manifest-listed MCP tool is destructive-hinted', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    vi.mocked(connectCliMcpClient).mockResolvedValue({
      listTools: async () => [
        {
          name: 'drop_table',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, destructiveHint: true },
        },
      ],
      callTool: vi.fn(),
      dispose,
    });
    const fetcher = vi.fn<Fetcher>();
    const deps = dependenciesWithFiles(
      {
        '/suite.json': suite({ tools: [{ kind: 'mcp', connectionId: 'docs' }] }),
        '/runtime.json': mcpRuntime,
      },
      fetcher
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const code = await runAgentEval(
        '/suite.json',
        { runtime: '/runtime.json', output: '/report.json' },
        deps
      );

      expect(code).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('destructiveHint'));
      expect(fetcher).not.toHaveBeenCalled();
      expect(deps.writeText).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });
});

describe('evaluateAgentBundle', () => {
  it('runs deterministic fixture tools in CI and fails a regressed baseline', async () => {
    const input: AgentBundle = {
      schemaVersion: 1,
      id: 'cli-bundle',
      name: 'CLI bundle',
      suite: suite({ tools: [{ kind: 'fixture', fixtureId: 'greeting' }] }),
      fixtures: [
        {
          id: 'greeting',
          tool: {
            name: 'get_greeting',
            description: 'Return the configured greeting.',
            inputSchema: { type: 'object', additionalProperties: false },
          },
          output: [{ type: 'text', text: 'hello' }],
        },
      ],
      baseline: { minPassRate: 1 },
    };
    const responseBody = JSON.stringify({
      id: 'response-1',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'not hello' }] }],
      usage: { input_tokens: 4, output_tokens: 1 },
    });
    const fetcher = vi.fn<Fetcher>().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      contentLengthHeader: null,
      text: async () => responseBody,
    });

    const result = await evaluateAgentBundle('/bundle.json', {}, dependencies(input, fetcher));

    expect(result.gates).toEqual([{ metric: 'passRate', expected: 1, actual: 0, passed: false }]);
    expect(agentBundleExitCode(result)).toBe(1);
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
