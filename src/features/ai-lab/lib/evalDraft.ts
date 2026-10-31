import type { EvalDraft, EvalTargetMode } from '../store/useAiLabUiStore';
import type { EvalConfig, EvalTarget, ModelRef, PromptTemplate } from '../types';
import { DEFAULT_PASS_THRESHOLD } from './evalPassThreshold';
import { modelKey } from './modelOptions';

export function targetFor(mode: EvalTargetMode): EvalTarget {
  if (mode === 'text') return { kind: 'text' };
  return { kind: 'http-exec', parseFrom: 'fenced', protocol: mode };
}

export function targetModeOf(target: EvalTarget | undefined): EvalTargetMode {
  if (target?.kind === 'http-exec') return target.protocol;
  return 'text';
}

/** Populate a draft from a saved eval config. Every persisted field must round-trip. */
export function draftFromConfig(
  config: EvalConfig,
  prompt: Pick<PromptTemplate, 'system' | 'user'> | undefined
): EvalDraft {
  return {
    configId: config.id,
    name: config.name,
    system: prompt?.system ?? '',
    user: prompt?.user ?? '',
    datasetId: config.datasetId,
    selected: config.models.map(modelKey),
    scorers: config.scorers,
    concurrency: config.concurrency,
    targetMode: targetModeOf(config.target),
    sendUnredactedToCloud: config.sendUnredactedToCloud === true,
    passThresholdPct: Math.round((config.passThreshold ?? DEFAULT_PASS_THRESHOLD) * 100),
    tools: config.tools ?? [],
  };
}

/** Build the EvalConfig a run executes and upsertEvalConfig persists. */
export function evalConfigFromDraft(
  draft: EvalDraft,
  init: { promptId: string; models: ModelRef[]; now: number }
): EvalConfig {
  return {
    id: draft.configId,
    name: draft.name,
    promptId: init.promptId,
    datasetId: draft.datasetId,
    models: init.models,
    scorers: draft.scorers,
    concurrency: draft.concurrency,
    target: targetFor(draft.targetMode),
    passThreshold: draft.passThresholdPct / 100,
    ...(draft.tools.length > 0 ? { tools: draft.tools } : {}),
    ...(draft.sendUnredactedToCloud ? { sendUnredactedToCloud: true } : {}),
    createdAt: init.now,
    updatedAt: init.now,
  };
}
