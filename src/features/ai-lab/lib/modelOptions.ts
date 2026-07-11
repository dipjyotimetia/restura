import type { ModelChecklistEntry } from '../components/ModelChecklist';
import type { AiLabModelDetail, AiLabProviderConfig, ModelRef } from '../types';

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
  /** Persisted catalog curation flags used to prioritize large model lists. */
  isFavorite: boolean;
  recentRank: number | null;
}

export interface ModelOptionCuration {
  favoriteModelKeys?: readonly string[];
  recentModelKeys?: readonly string[];
}

/**
 * Canonical "provider · friendly model name" label for a model ref — the same
 * rule buildModelOptions applies, exported so run snapshots (useEvalRun) can't
 * drift from what the checklists and reports show. Falls back to the bare
 * model id when the provider no longer exists.
 */
export function modelLabelFor(
  providers: Record<string, AiLabProviderConfig>,
  ref: ModelRef
): string {
  const cfg = providers[ref.providerConfigId];
  if (!cfg) return ref.model;
  return `${cfg.label} · ${cfg.modelDetails?.[ref.model]?.label ?? ref.model}`;
}

export function buildModelOptions(
  providers: Record<string, AiLabProviderConfig>,
  curation: ModelOptionCuration = {}
): ModelOption[] {
  const favorites = new Set(curation.favoriteModelKeys ?? []);
  const recentRanks = new Map((curation.recentModelKeys ?? []).map((key, index) => [key, index]));
  const out: ModelOption[] = [];
  for (const cfg of Object.values(providers)) {
    for (const model of cfg.models) {
      // Prefer the human-readable label from discovery (e.g. "Claude 3.5
      // Sonnet") over the slash-namespaced id; the id is still surfaced as a
      // tooltip / dim caption in the checklist.
      const detail = cfg.modelDetails?.[model];
      const shortLabel = detail?.label ?? model;
      const key = `${cfg.id}:${model}`;
      const isFavorite = favorites.has(key);
      out.push({
        key,
        cfg,
        model,
        label: `${cfg.label} · ${shortLabel}`,
        shortLabel,
        isFavorite,
        recentRank: isFavorite ? null : (recentRanks.get(key) ?? null),
        ...(detail ? { detail } : {}),
      });
    }
  }
  return out.sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    const aRecent = a.recentRank ?? Number.POSITIVE_INFINITY;
    const bRecent = b.recentRank ?? Number.POSITIVE_INFINITY;
    if (aRecent !== bRecent) return aRecent - bRecent;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
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

/** `providerConfigId:model` round-trip — the selection key used across the AI Lab. */
export function modelKey(m: ModelRef): string {
  return `${m.providerConfigId}:${m.model}`;
}

/**
 * Split on the FIRST colon only: the provider id is a UUID (no colons) but
 * model ids can contain them (Ollama `llama3.2:latest`).
 */
export function parseModelKey(key: string): ModelRef {
  const idx = key.indexOf(':');
  return { providerConfigId: key.slice(0, idx), model: key.slice(idx + 1) };
}

/** Toggle a key in a selection list (the drafts store selections as arrays). */
export function toggleKey(selected: string[], key: string): string[] {
  return selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
}

/** Set counterpart of toggleKey (expanded-row state and the like). */
export function toggleSetKey(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
