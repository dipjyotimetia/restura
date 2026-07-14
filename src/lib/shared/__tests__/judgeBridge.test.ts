import { JUDGE_TOOL } from '@shared/protocol/ai/judge';
import type { CompletionResult } from '@shared/protocol/ai/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeSettings } from '@/types';
import { makeRendererJudge } from '../judgeBridge';

// Installs a fake window.electron.aiLab (mirrors the llmClient bridge test) so
// the judge closure can exercise the real IPC path without Electron.

type CompleteFn = ReturnType<typeof vi.fn>;
type CompleteSpec = Parameters<NonNullable<Window['electron']>['aiLab']['complete']>[0];

let complete: CompleteFn;

function verdictResult(): { ok: true; result: CompletionResult } {
  return {
    ok: true,
    result: {
      ok: true,
      text: '',
      toolCalls: [
        {
          id: 't1',
          name: JUDGE_TOOL.name,
          input: JSON.stringify({ score: 0.9, reasoning: 'good', pass: true }),
        },
      ],
    },
  };
}

function installBridge(impl?: () => unknown) {
  complete = vi.fn(impl ?? (async () => verdictResult()));
  (window as unknown as { electron: unknown }).electron = {
    isElectron: true,
    aiLab: { complete },
  };
}

const CLOUD_CFG: JudgeSettings = {
  enabled: true,
  provider: 'openai',
  model: 'gpt-judge',
  apiKeyHandleId: 'h1',
  redactBeforeJudge: false,
};

const LOCAL_CFG: JudgeSettings = {
  enabled: true,
  provider: 'ollama',
  model: 'llama-judge',
  baseUrl: 'http://localhost:11434',
  redactBeforeJudge: false,
};

function lastSpec(): CompleteSpec {
  return complete.mock.calls[0]![0] as CompleteSpec;
}

describe('makeRendererJudge', () => {
  beforeEach(() => installBridge());
  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('returns the parsed verdict on success', async () => {
    const judge = makeRendererJudge(CLOUD_CFG);
    const verdict = await judge({ output: 'answer', rubric: 'is it good?' });
    expect(verdict).toMatchObject({ score: 0.9, reasoning: 'good', pass: true });
    expect(verdict.samples).toBe(1);
    expect(verdict.perCriterion).toHaveLength(1);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('builds a well-formed spec (per-criterion judge tool, rawMode true)', async () => {
    const judge = makeRendererJudge(CLOUD_CFG);
    await judge({ output: 'answer', rubric: 'rubric' });
    const spec = lastSpec();
    expect(spec.rawMode).toBe(true);
    expect(spec.tools?.[0]?.name).toBe(JUDGE_TOOL.name);
    expect(spec.tools?.[0]?.inputSchema).toHaveProperty('properties.criteria');
    expect(spec.provider).toBe('openai');
    expect(spec.model).toBe('gpt-judge');
    expect(spec.apiKeyHandleId).toBe('h1');
    expect(spec.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('sets baseUrlOverride for a local provider with a base URL', async () => {
    const judge = makeRendererJudge(LOCAL_CFG);
    await judge({ output: 'answer', rubric: 'rubric' });
    expect(lastSpec().baseUrlOverride).toBe('http://localhost:11434');
  });

  it('redacts a secret-looking token in the candidate output when enabled', async () => {
    const judge = makeRendererJudge({ ...CLOUD_CFG, redactBeforeJudge: true });
    await judge({ output: 'key is sk-abcdefghijklmnop1234', rubric: 'rubric' });
    const userMsg = lastSpec().messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('[REDACTED]');
    expect(userMsg.content).not.toContain('sk-abcdefghijklmnop1234');
  });

  it('passes the candidate output through verbatim when redaction is disabled', async () => {
    const judge = makeRendererJudge(CLOUD_CFG);
    await judge({ output: 'key is sk-abcdefghijklmnop1234', rubric: 'rubric' });
    const userMsg = lastSpec().messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('sk-abcdefghijklmnop1234');
    expect(userMsg.content).not.toContain('[REDACTED]');
  });

  it('redacts a secret in the reference when redaction is enabled', async () => {
    const judge = makeRendererJudge({ ...CLOUD_CFG, redactBeforeJudge: true });
    await judge({ output: 'answer', rubric: 'rubric', reference: 'gold sk-abcdefghijklmnop1234' });
    const userMsg = lastSpec().messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).not.toContain('sk-abcdefghijklmnop1234');
  });

  it('throws with the IPC error message when complete returns { ok: false }', async () => {
    installBridge(async () => ({ ok: false, error: 'judge boom' }));
    const judge = makeRendererJudge(CLOUD_CFG);
    await expect(judge({ output: 'a', rubric: 'r' })).rejects.toThrow('judge boom');
  });

  it('throws when the model call fails even though the IPC envelope succeeded', async () => {
    installBridge(async () => ({
      ok: true,
      result: {
        ok: false,
        text: '',
        toolCalls: [],
        error: { code: 'provider', message: 'rate limited' },
      },
    }));
    const judge = makeRendererJudge(CLOUD_CFG);
    await expect(judge({ output: 'a', rubric: 'r' })).rejects.toThrow(/rate limited/);
  });

  it('throws when not running in the desktop app', async () => {
    delete (window as unknown as { electron?: unknown }).electron;
    const judge = makeRendererJudge(CLOUD_CFG);
    await expect(judge({ output: 'a', rubric: 'r' })).rejects.toThrow(
      'rs.judge requires the desktop app'
    );
  });

  it('throws an actionable error when a cloud provider has no API key', async () => {
    const judge = makeRendererJudge({ ...CLOUD_CFG, apiKeyHandleId: undefined });
    await expect(judge({ output: 'a', rubric: 'r' })).rejects.toThrow(/set an API key/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('throws when a local provider has no base URL', async () => {
    const judge = makeRendererJudge({ ...LOCAL_CFG, baseUrl: undefined });
    await expect(judge({ output: 'a', rubric: 'r' })).rejects.toThrow(/base URL/);
  });
});
