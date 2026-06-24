// Host-side LLM-as-judge bridge for the script sandbox.
//
// `makeRendererJudge(cfg)` returns the closure the QuickJS script sandbox calls
// (via `rs.judge`). It optionally redacts the candidate output/reference, then
// delegates the entire judging algorithm (criteria, self-consistency sampling,
// aggregation) to the shared `runJudge` engine — injecting only transport (the
// Electron non-streaming completion IPC). Electron-only — the web build has no
// AI Lab `complete` IPC, so the closure throws there.
//
// Depends only on @shared/protocol/ai/* and @/lib/shared/platform — no
// cross-feature imports (the script-sandbox host owns this glue).
import {
  runJudge,
  type JudgeComplete,
  type JudgeRequestInput,
  type JudgeVerdict,
} from '@shared/protocol/ai/judge';
import { redactBody } from '@shared/protocol/ai/redaction';
import { isLocalProvider } from '@shared/protocol/ai/types';
import { isElectron } from '@/lib/shared/platform';
import type { JudgeSettings } from '@/types';

type JudgeTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/**
 * Build the host-side judge closure. The returned function takes a
 * {@link JudgeRequestInput} and resolves to a {@link JudgeVerdict}.
 */
export function makeRendererJudge(
  cfg: JudgeSettings
): (input: JudgeRequestInput) => Promise<JudgeVerdict> {
  return async (input: JudgeRequestInput): Promise<JudgeVerdict> => {
    const complete = typeof window !== 'undefined' ? window.electron?.aiLab?.complete : undefined;
    if (!isElectron() || !complete) {
      throw new Error('rs.judge requires the desktop app');
    }
    // Local runtimes (ollama / openai-compatible) require a base URL — the IPC's
    // Zod refine rejects the call otherwise. Cloud providers require an API key
    // handle, or the secret resolver fails downstream with a cryptic error.
    // Fail fast, with an actionable message, before doing any work.
    if (isLocalProvider(cfg.provider)) {
      if (!cfg.baseUrl) {
        throw new Error('rs.judge requires a base URL for local providers');
      }
    } else if (!cfg.apiKeyHandleId) {
      throw new Error('rs.judge: set an API key for the judge provider in Settings → AI');
    }

    // The candidate output (and the reference, often pulled from an env var) may
    // carry secrets echoed from a response body. When configured, scrub both
    // before they reach the judge model — rawMode disables the backend pass, so
    // this is the only redaction on the prompt content. Rubric/criteria/anchor
    // text is user-authored, not response data, so it is not redacted.
    const redact = (s: string): string => (cfg.redactBeforeJudge ? redactBody(s, 'default') : s);
    const redactedInput: JudgeRequestInput = {
      ...input,
      output: redact(input.output),
      ...(input.reference !== undefined ? { reference: redact(input.reference) } : {}),
    };

    // rawMode: true — we own and (optionally) redact the prompt content here, so
    // the backend paranoia pass would only false-positive on legitimate rubric
    // text (e.g. a rubric that mentions "token"). The local-provider SSRF
    // carve-out still requires baseUrlOverride to be present.
    const runComplete: JudgeComplete = async (messages, tools) => {
      const spec = {
        provider: cfg.provider,
        model: cfg.model,
        messages,
        rawMode: true as const,
        tools: tools as JudgeTool[],
        ...(cfg.apiKeyHandleId !== undefined ? { apiKeyHandleId: cfg.apiKeyHandleId } : {}),
        ...(cfg.baseUrl !== undefined ? { baseUrlOverride: cfg.baseUrl } : {}),
      };
      const res = await complete(spec);
      if (!res.ok) {
        throw new Error(res.error);
      }
      // The IPC envelope succeeding doesn't mean the model call did — a provider
      // error (5xx, rate limit, bad/empty model) returns ok:true with an inner
      // failed CompletionResult. Return it; runJudge surfaces the inner error.
      return res.result;
    };

    return runJudge(redactedInput, runComplete);
  };
}
