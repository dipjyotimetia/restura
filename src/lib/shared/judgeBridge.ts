// Host-side LLM-as-judge bridge for the script sandbox.
//
// `makeRendererJudge(cfg)` returns the closure the QuickJS script sandbox calls
// (via `rs.judge`). It builds a judge prompt with the shared judge engine,
// optionally redacts the candidate output, calls the Electron non-streaming
// completion IPC, and parses the verdict. Electron-only — the web build has no
// AI Lab `complete` IPC, so the closure throws there.
//
// Depends only on @shared/protocol/ai/* and @/lib/shared/platform — no
// cross-feature imports (the script-sandbox host owns this glue).
import { isElectron } from '@/lib/shared/platform';
import type { JudgeSettings } from '@/types';
import {
  JUDGE_TOOL,
  buildJudgeMessages,
  parseJudgment,
  type JudgeRequestInput,
  type JudgeVerdict,
} from '@shared/protocol/ai/judge';
import { redactBody } from '@shared/protocol/ai/redaction';
import { isLocalProvider } from '@shared/protocol/ai/types';

/** Default pass bar when the caller doesn't supply one. Matches buildJudgeMessages' framing. */
const DEFAULT_PASS_THRESHOLD = 0.5;

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
    // Fail fast, with an actionable message, before building the prompt.
    if (isLocalProvider(cfg.provider)) {
      if (!cfg.baseUrl) {
        throw new Error('rs.judge requires a base URL for local providers');
      }
    } else if (!cfg.apiKeyHandleId) {
      throw new Error('rs.judge: set an API key for the judge provider in Settings → AI');
    }

    const passThreshold = input.passThreshold ?? DEFAULT_PASS_THRESHOLD;

    // The candidate output may carry secrets echoed from a response body. When
    // configured, scrub them before they reach the judge model.
    const output = cfg.redactBeforeJudge ? redactBody(input.output, 'default') : input.output;

    const messages = buildJudgeMessages({
      rubric: input.rubric,
      output,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      passThreshold,
    });

    // rawMode: true — we own and (optionally) redact the prompt content here, so
    // the backend paranoia pass would only false-positive on legitimate rubric
    // text (e.g. a rubric that mentions "token"). The local-provider SSRF
    // carve-out still requires baseUrlOverride to be present.
    const spec = {
      provider: cfg.provider,
      model: cfg.model,
      messages,
      rawMode: true,
      tools: [JUDGE_TOOL],
      ...(cfg.apiKeyHandleId !== undefined ? { apiKeyHandleId: cfg.apiKeyHandleId } : {}),
      ...(cfg.baseUrl !== undefined ? { baseUrlOverride: cfg.baseUrl } : {}),
    };

    const res = await complete(spec);
    if (!res.ok) {
      throw new Error(res.error);
    }
    return parseJudgment(res.result, passThreshold);
  };
}
