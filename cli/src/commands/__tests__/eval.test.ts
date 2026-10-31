import type { EvalFile } from '@shared/ai-lab/evalFile';
import type { Fetcher, FetcherResponse } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type EvalRunDependencies,
  evalRunExitCode,
  evaluateEvalFile,
  renderEvalJUnit,
  runEvalCommand,
} from '../eval';

function file(overrides: Partial<EvalFile> = {}): EvalFile {
  return {
    kind: 'restura.eval',
    schemaVersion: 1,
    name: 'Greeting',
    prompt: { system: '', user: 'Say {{word}}' },
    dataset: {
      name: 'd',
      cases: [
        { id: 'c1', vars: { word: 'hello' }, expected: 'hello' },
        { id: 'c2', vars: { word: 'bye' }, expected: 'bye', split: 'test' },
      ],
    },
    endpoints: {
      oa: { provider: 'openai', label: 'OpenAI', credentialEnv: 'OPENAI_API_KEY' },
      claude: { provider: 'anthropic', credentialEnv: 'ANTHROPIC_API_KEY' },
    },
    models: [{ providerConfigId: 'oa', model: 'gpt-6-luna' }],
    scorers: [{ id: 'exact', kind: 'exact-match', expectedFrom: 'expected' }],
    concurrency: 1,
    passThreshold: 1,
    ...overrides,
  };
}

/** OpenAI chat-completions SSE that answers with the word the prompt asked for. */
function openAiStream(text: string): FetcherResponse {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    contentLengthHeader: null,
    text: async () => body,
    body: new Response(body).body,
  };
}

function echoFetcher(transform = (word: string) => word) {
  return vi.fn<Fetcher>(async (request) => {
    const sent = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> };
    const word = sent.messages.at(-1)!.content.replace('Say ', '');
    return openAiStream(transform(word));
  });
}

function deps(
  input: unknown,
  fetcher: Fetcher,
  environment: Record<string, string> = { OPENAI_API_KEY: 'sk-test' }
) {
  const written: Record<string, string> = {};
  const dependencies: EvalRunDependencies = {
    readText: vi.fn().mockResolvedValue(JSON.stringify(input)),
    writeText: vi.fn(async (path: string, content: string) => {
      written[path] = content;
    }),
    fetcher,
    environment,
  };
  return { dependencies, written };
}

describe('restura eval run (#1045)', () => {
  it('passes when every cell meets the threshold and writes JSON + JUnit', async () => {
    const fetcher = echoFetcher();
    const { dependencies, written } = deps(file(), fetcher);
    const report = await evaluateEvalFile(
      '/e.json',
      { output: '/r.json', junit: '/j.xml' },
      dependencies
    );

    expect(report.status).toBe('passed');
    expect(report.passed).toBe(2);
    expect(evalRunExitCode(report)).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[0]![0].headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test'
    );
    expect(JSON.parse(written['/r.json']!).cells).toHaveLength(2);
    expect(written['/j.xml']).toContain(
      '<testsuite name="Greeting" tests="2" failures="0" errors="0"'
    );
    expect(written['/j.xml']).toContain('classname="OpenAI/gpt-6-luna" name="c1"');
  });

  it('fails below the pass threshold and records the failing scorer in JUnit', async () => {
    const fetcher = echoFetcher((word) => (word === 'bye' ? 'nope' : word));
    const { dependencies, written } = deps(file({ passThreshold: 0.75 }), fetcher);
    const report = await evaluateEvalFile('/e.json', { junit: '/j.xml' }, dependencies);
    expect(report.status).toBe('failed');
    expect(report.passRate).toBe(0.5);
    expect(evalRunExitCode(report)).toBe(1);
    expect(written['/j.xml']).toContain(
      '<failure message="1 scorer(s) failed">exact (exact-match)'
    );
  });

  it('a lower threshold lets a partial pass through', async () => {
    const fetcher = echoFetcher((word) => (word === 'bye' ? 'nope' : word));
    const report = await evaluateEvalFile(
      '/e.json',
      {},
      deps(file({ passThreshold: 0.5 }), fetcher).dependencies
    );
    expect(report.status).toBe('passed');
  });

  it('runs judges with env credentials (no longer refused)', async () => {
    const fetcher = vi.fn<Fetcher>(async (request) => {
      if (request.url.includes('anthropic')) {
        const body = [
          `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } })}`,
          `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'submit_verdict' } })}`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ score: 0.9, pass: true, reasoning: 'good' }) } })}`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
          '',
        ].join('\n\n');
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          contentLengthHeader: null,
          text: async () => body,
          body: new Response(body).body,
        };
      }
      return openAiStream('hello');
    });
    const judged = file({
      dataset: { name: 'd', cases: [{ id: 'c1', vars: { word: 'hello' } }] },
      scorers: [
        {
          id: 'judge',
          kind: 'judge',
          judgeModel: { providerConfigId: 'claude', model: 'claude-sonnet-5-5' },
          passThreshold: 0.5,
          rubric: 'Is it a greeting?',
        },
      ],
    });
    const { dependencies } = deps(judged, fetcher, {
      OPENAI_API_KEY: 'sk-a',
      ANTHROPIC_API_KEY: 'sk-b',
    });
    const report = await evaluateEvalFile('/e.json', {}, dependencies);
    expect(fetcher.mock.calls.some(([request]) => request.url.includes('anthropic'))).toBe(true);
    expect(report.cells[0]?.scores[0]).toMatchObject({ kind: 'judge' });
  });

  it.each([
    ['a missing credential', file(), {}, /OPENAI_API_KEY/],
    ['no scorers', file({ scorers: [] }), undefined, /no scorers/],
    [
      'self-judging',
      file({
        scorers: [
          {
            id: 'j',
            kind: 'judge',
            judgeModel: { providerConfigId: 'oa', model: 'gpt-6-luna' },
            passThreshold: 0.5,
          },
        ],
      }),
      undefined,
      /model under test/,
    ],
    [
      'http-exec',
      file({ target: { kind: 'http-exec', parseFrom: 'json', protocol: 'http' } }),
      undefined,
      /desktop only/,
    ],
    [
      'a localhost runtime without --allow-localhost',
      file({
        endpoints: { oa: { provider: 'ollama', baseUrl: 'http://localhost:11434' } },
      }),
      undefined,
      /allow-localhost/,
    ],
    [
      'an unknown endpoint',
      { ...file(), models: [{ providerConfigId: 'nope', model: 'x' }] },
      undefined,
      /unknown endpoint/,
    ],
  ])('exits 2 before any model call for %s', async (_name, input, environment, pattern) => {
    const fetcher = vi.fn<Fetcher>();
    const { dependencies } = deps(input, fetcher, environment);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await runEvalCommand('/e.json', {}, dependencies)).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(pattern));
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('refuses --max-cost over an unpriced model, and stops once the budget is spent', async () => {
    const unpriced = file({ models: [{ providerConfigId: 'oa', model: 'unlisted-model' }] });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        await runEvalCommand('/e.json', { maxCost: '1' }, deps(unpriced, vi.fn()).dependencies)
      ).toBe(2);
    } finally {
      stderr.mockRestore();
    }

    // gpt-6-luna is $0.10 per million input tokens; each call reports 1M input tokens.
    const fetcher = echoFetcher();
    const report = await evaluateEvalFile(
      '/e.json',
      { maxCost: '0.05' },
      deps(file(), fetcher).dependencies
    );
    expect(report.status).toBe('cancelled');
    expect(report.reason).toMatch(/cost budget exceeded/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(evalRunExitCode(report)).toBe(1);
  });

  it('runs only the selected split', async () => {
    const fetcher = echoFetcher();
    const report = await evaluateEvalFile(
      '/e.json',
      { split: 'test' },
      deps(file(), fetcher).dependencies
    );
    expect(report.cells.map((cell) => cell.caseId)).toEqual(['c2']);
  });

  it('escapes XML in JUnit output', () => {
    const xml = renderEvalJUnit(
      {
        kind: 'restura.eval.report',
        schemaVersion: 1,
        name: 'a<b',
        status: 'failed',
        passThreshold: 1,
        passed: 0,
        scored: 1,
        passRate: 0,
        totalCells: 1,
        costUSD: 0,
        unpricedCalls: 0,
        startedAt: '',
        finishedAt: '',
        cells: [
          {
            caseId: 'c&1',
            modelRef: { providerConfigId: 'oa', model: 'm' },
            output: '',
            ok: false,
            error: 'bad "quote"\u0001',
            latencyMs: 5,
            cost: null,
            scores: [],
            passed: false,
          },
        ],
      },
      file()
    );
    expect(xml).toContain('name="a&lt;b"');
    expect(xml).toContain('name="c&amp;1"');
    expect(xml).toContain('<error message="bad &quot;quote&quot;">');
  });
});
