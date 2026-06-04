import { describe, it, expect, vi, afterEach } from 'vitest';
import ScriptExecutor from '../scriptExecutor';
import { makeRendererJudge } from '@/lib/shared/judgeBridge';
import { JUDGE_TOOL } from '@shared/protocol/ai/judge';
import type { CompletionResult } from '@shared/protocol/ai/types';

/**
 * End-to-end glue test: the REAL `rs.judge` sandbox bridge resolving through
 * the REAL `makeRendererJudge` closure against a faked `aiLab.complete` IPC.
 *
 * The per-layer unit tests stub `host.judge` (sandbox side) or `aiLab.complete`
 * (bridge side) independently — neither proves the QuickJS deferred-promise /
 * pending-op / handle-cleanup dance in `bindPmJudge` actually settles when a
 * verdict comes back through the bridge. This test exercises that whole path
 * (and the runtime disposes cleanly afterwards, or QuickJS would assert).
 */

interface CompleteSpec {
  provider: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown;
}
type CompleteImpl = (spec: CompleteSpec) => unknown;

function installBridge(impl?: CompleteImpl) {
  const complete = vi.fn<(spec: CompleteSpec) => unknown>(
    impl ??
      (async () => ({
        ok: true,
        result: {
          ok: true,
          text: '',
          toolCalls: [
            {
              id: 't1',
              name: JUDGE_TOOL.name,
              input: JSON.stringify({ score: 0.92, reasoning: 'accurate', pass: true }),
            },
          ],
        } satisfies CompletionResult,
      }))
  );
  (window as unknown as { electron: unknown }).electron = {
    isElectron: true,
    aiLab: { complete },
  };
  return complete;
}

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

describe('rs.judge ⇄ makeRendererJudge integration', () => {
  it('a verdict from aiLab.complete propagates back into the sandbox assertion', async () => {
    const complete = installBridge();
    const judge = makeRendererJudge({
      enabled: true,
      provider: 'openai',
      model: 'gpt-judge',
      apiKeyHandleId: 'h1',
      redactBeforeJudge: false,
    });
    const ex = new ScriptExecutor({ host: { judge } });
    const r = await ex.executeScript(
      `
      (async function () {
        const v = await rs.judge(response.body, { rubric: 'Answers the question' });
        pm.test('answer is correct', function () {
          pm.expect(v.pass).to.be.true;
          pm.expect(v.score).to.equal(0.92);
          pm.expect(v.reasoning).to.equal('accurate');
        });
      })();
    `,
      {
        response: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: 'The capital of France is Paris.',
          time: 4,
          size: 31,
        },
      }
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    // The candidate output reached the judge request unredacted.
    const userMsg = complete.mock.calls[0]![0].messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('The capital of France is Paris.');
  });

  it('redacts the candidate output before it leaves when redactBeforeJudge is on', async () => {
    const complete = installBridge();
    const judge = makeRendererJudge({
      enabled: true,
      provider: 'openai',
      model: 'gpt-judge',
      apiKeyHandleId: 'h1',
      redactBeforeJudge: true,
    });
    const ex = new ScriptExecutor({ host: { judge } });
    await ex.executeScript(
      `(async function () { await rs.judge(response.body, { rubric: 'r' }); })();`,
      {
        response: {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: 'token: sk-abcdefghijklmnop1234',
          time: 4,
          size: 31,
        },
      }
    );
    const userMsg = complete.mock.calls[0]![0].messages.find((m) => m.role === 'user')!;
    expect(userMsg.content).not.toContain('sk-abcdefghijklmnop1234');
  });

  it('a bridge error surfaces as a catchable rejection inside the script', async () => {
    installBridge(async () => ({ ok: false, error: 'judge provider down' }));
    const judge = makeRendererJudge({
      enabled: true,
      provider: 'openai',
      model: 'gpt-judge',
      apiKeyHandleId: 'h1',
      redactBeforeJudge: false,
    });
    const ex = new ScriptExecutor({ host: { judge } });
    const r = await ex.executeScript(
      `
      (async function () {
        try {
          await rs.judge('x', { rubric: 'r' });
          pm.test('unreachable', function () { pm.expect.fail('should throw'); });
        } catch (e) {
          pm.test('caught', function () {
            pm.expect(String(e.message)).to.match(/judge provider down/);
          });
        }
      })();
    `,
      {}
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });
});
