import type { ModelChecklistEntry } from '../components/ModelChecklist';
import type { AiLabModelDetail, AiLabProviderConfig } from '../types';

/**
 * One selectable provider+model pair, flattened from the provider configs.
 * Built identically by Playground / EvalBuilder / Arena — kept here so the
 * label rules ("provider · friendly model name") can't drift between tabs.
 */
export interface ModelOption {
  /** `providerConfigId:model` — the selection key used across the AI Lab. */
  key: string;
  cfg: AiLabProviderConfig;
  model: string;
  /** Full label incl. provider, e.g. "OpenRouter · Claude 3.5 Sonnet". */
  label: string;
  /** Model-only label for contexts already grouped by provider. */
  shortLabel: string;
  /** Rich discovery metadata (if any). */
  detail?: AiLabModelDetail;
}

export function buildModelOptions(providers: Record<string, AiLabProviderConfig>): ModelOption[] {
  const out: ModelOption[] = [];
  for (const cfg of Object.values(providers)) {
    for (const model of cfg.models) {
      // Prefer the human-readable label from discovery (e.g. "Claude 3.5
      // Sonnet") over the slash-namespaced id; the id is still surfaced as a
      // tooltip / dim caption in the checklist.
      const detail = cfg.modelDetails?.[model];
      const shortLabel = detail?.label ?? model;
      out.push({
        key: `${cfg.id}:${model}`,
        cfg,
        model,
        label: `${cfg.label} · ${shortLabel}`,
        shortLabel,
        ...(detail ? { detail } : {}),
      });
    }
  }
  return out;
}

/** Map options to checklist entries (grouped under their provider). */
export function toChecklistEntries(options: ModelOption[]): ModelChecklistEntry[] {
  return options.map((m) => ({
    key: m.key,
    label: m.shortLabel,
    group: m.cfg.label,
    id: m.model,
    ...(m.detail ? { detail: m.detail } : {}),
  }));
}

/** "1 model" / "3 models" — replaces the lazy "model(s)" copy. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
