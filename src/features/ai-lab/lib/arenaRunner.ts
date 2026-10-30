// Arena orchestrator: run N models over a dataset, then judge every model pair
// head-to-head (round-robin, position-swapped) to produce pairwise matches that
// fold into an Elo leaderboard. Mirrors evalRunner's bounded-concurrency +
// cancellation shape. Model calls cross IPC via completeLlm; the comparison
// algorithm lives in the shared runPairwiseJudge.
import { type JudgeComplete, runPairwiseJudge } from '@shared/protocol/ai/judge';
import { completeWithRetry } from '@/lib/shared/completeRetry';
import type { AiLabProviderConfig, ArenaRunStatus, Dataset, ModelRef } from '../types';
import { runPool } from './concurrencyPool';
import type { PairwiseMatch } from './elo';
import { completeLlm, type LlmCallSpec, type LlmChatMessage, specFor } from './llmClient';

export interface ArenaInput {
  dataset: Dataset;
  /** Contestant models (>= 2). */
  models: ModelRef[];
  /** Model that judges the pairwise comparisons. */
  judgeModel: ModelRef;
  providers: Record<string, AiLabProviderConfig>;
  concurrency: number;
  /** System prompt sent to every contestant (optional). */
  system?: string;
}

export interface ArenaProgress {
  phase: 'generating' | 'judging' | 'done';
  completed: number;
  total: number;
}

export interface ArenaResult {
  matches: PairwiseMatch[];
  /** Model keys (providerConfigId:model) of the contestants, in input order. */
  modelKeys: string[];
}

/**
 * A run that failed after producing some matches. Carries them so the caller
 * can keep the partial results instead of discarding them.
 */
export class ArenaRunError extends Error {
  readonly matches: PairwiseMatch[];
  constructor(cause: unknown, matches: PairwiseMatch[]) {
    super(errorText(cause));
    this.name = 'ArenaRunError';
    this.cause = cause;
    this.matches = matches;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run status from the collected matches: errored matches never read as a clean `done`. */
export function arenaRunStatus(matches: PairwiseMatch[], aborted: boolean): ArenaRunStatus {
  if (aborted) return 'cancelled';
  const errored = matches.filter((m) => m.winner === 'error').length;
  if (errored === 0) return 'done';
  return errored === matches.length ? 'error' : 'partial';
}

export function modelKeyOf(m: ModelRef): string {
  return `${m.providerConfigId}:${m.model}`;
}

function buildMessages(system: string | undefined, userText: string): LlmChatMessage[] {
  const messages: LlmChatMessage[] = [];
  if (system && system.trim()) messages.push({ role: 'system', content: system.trim() });
  messages.push({ role: 'user', content: userText });
  return messages;
}

/** The user text for a case: its `prompt` var, else `input`, else the whole vars JSON. */
function caseUserText(vars: Record<string, string>): string {
  return vars.prompt ?? vars.input ?? vars.question ?? JSON.stringify(vars);
}

/** Run the arena end-to-end. Returns the raw pairwise matches for Elo folding. */
export async function runArena(
  input: ArenaInput,
  onProgress: (p: ArenaProgress) => void,
  signal: AbortSignal
): Promise<ArenaResult> {
  // Fail loudly instead of silently no-opping a contestant/judge whose provider
  // was removed after being selected (e.g. deleted in the Providers tab while
  // this config was still open) — a missing config previously left that
  // model's outputs as '' with no indication anything was wrong.
  for (const m of input.models) {
    if (!input.providers[m.providerConfigId]) {
      throw new Error(`Provider config for contestant "${modelKeyOf(m)}" no longer exists.`);
    }
  }
  if (!input.providers[input.judgeModel.providerConfigId]) {
    throw new Error(
      `Provider config for judge "${modelKeyOf(input.judgeModel)}" no longer exists.`
    );
  }

  const modelKeys = input.models.map(modelKeyOf);
  // Place each result at its task index, NOT in completion order: Elo is
  // path-dependent, so folding matches in a stable order is what makes a run
  // reproducible for identical inputs (computeElo's contract).
  const slots: Array<PairwiseMatch | undefined> = [];
  const collected = () => slots.filter((m): m is PairwiseMatch => m !== undefined);
  try {
    return await runArenaPhases(input, onProgress, signal, modelKeys, slots, collected);
  } catch (e) {
    throw new ArenaRunError(e, collected());
  }
}

async function runArenaPhases(
  input: ArenaInput,
  onProgress: (p: ArenaProgress) => void,
  signal: AbortSignal,
  modelKeys: string[],
  slots: Array<PairwiseMatch | undefined>,
  collected: () => PairwiseMatch[]
): Promise<ArenaResult> {
  // Phase A: generate every contestant's output per case → outputs[caseId][modelKey].
  const outputs: Record<string, Record<string, string>> = {};
  // Contestant calls that failed (provider error / thrown) — a match involving
  // one is an error, never a tie.
  const failures: Record<string, Record<string, string>> = {};
  const genTasks: Array<{ caseId: string; userText: string; model: ModelRef }> = [];
  for (const c of input.dataset.cases) {
    outputs[c.id] = {};
    failures[c.id] = {};
    const userText = caseUserText(c.vars);
    for (const m of input.models) genTasks.push({ caseId: c.id, userText, model: m });
  }
  let genDone = 0;
  await runPool(genTasks, input.concurrency, signal, async (t) => {
    const cfg = input.providers[t.model.providerConfigId];
    if (cfg) {
      const key = modelKeyOf(t.model);
      try {
        const completion = await completeWithRetry(() =>
          completeLlm(specFor(cfg, t.model.model, buildMessages(input.system, t.userText)))
        );
        if (completion.ok) outputs[t.caseId]![key] = completion.text;
        else failures[t.caseId]![key] = completion.error?.message ?? 'completion failed';
      } catch (e) {
        failures[t.caseId]![key] = errorText(e);
      }
    }
    genDone++;
    onProgress({ phase: 'generating', completed: genDone, total: genTasks.length });
  });
  if (signal.aborted) return { matches: [], modelKeys };

  // Phase B: judge every unordered model pair per case.
  const judgeCfg = input.providers[input.judgeModel.providerConfigId];
  const complete: JudgeComplete = (messages, tools) =>
    completeWithRetry(() =>
      completeLlm(
        specFor(judgeCfg!, input.judgeModel.model, messages as LlmChatMessage[], {
          tools: tools as LlmCallSpec['tools'],
        })
      )
    );

  const judgeTasks: Array<{ caseId: string; aKey: string; bKey: string }> = [];
  for (const c of input.dataset.cases) {
    for (let i = 0; i < modelKeys.length; i++) {
      for (let j = i + 1; j < modelKeys.length; j++) {
        judgeTasks.push({ caseId: c.id, aKey: modelKeys[i]!, bKey: modelKeys[j]! });
      }
    }
  }

  let judgeDone = 0;
  if (judgeCfg) {
    await runPool(judgeTasks, input.concurrency, signal, async (t, idx) => {
      const outA = outputs[t.caseId]?.[t.aKey] ?? '';
      const outB = outputs[t.caseId]?.[t.bKey] ?? '';
      const failed = [
        failures[t.caseId]?.[t.aKey] && `${t.aKey}: ${failures[t.caseId]![t.aKey]}`,
        failures[t.caseId]?.[t.bKey] && `${t.bKey}: ${failures[t.caseId]![t.bKey]}`,
      ].filter(Boolean);
      let match: PairwiseMatch;
      if (failed.length > 0) {
        // A contestant call failed: there is nothing fair to judge, and calling
        // it a tie would hide a bad key / outage behind a plausible leaderboard.
        match = { a: t.aKey, b: t.bKey, winner: 'error', error: failed.join('; ') };
      } else if (!outA && !outB) {
        match = { a: t.aKey, b: t.bKey, winner: 'tie' }; // both models genuinely answered ''
      } else {
        try {
          const v = await runPairwiseJudge(
            { outputA: outA, outputB: outB, swapPositions: true },
            complete
          );
          const winner = v.winner === 'A' ? 'a' : v.winner === 'B' ? 'b' : 'tie';
          match = { a: t.aKey, b: t.bKey, winner };
        } catch (e) {
          match = { a: t.aKey, b: t.bKey, winner: 'error', error: `judge: ${errorText(e)}` };
        }
      }
      slots[idx] = match;
      judgeDone++;
      onProgress({ phase: 'judging', completed: judgeDone, total: judgeTasks.length });
    });
  }

  onProgress({ phase: 'done', completed: judgeDone, total: judgeTasks.length });
  // collected() drops holes left by an aborted run; a completed run is dense
  // and in judgeTasks (round-robin) order.
  return { matches: collected(), modelKeys };
}
