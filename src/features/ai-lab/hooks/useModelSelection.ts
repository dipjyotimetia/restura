import { useCallback, useMemo } from 'react';
import type { ModelChecklistEntry } from '../components/ModelChecklist';
import {
  buildModelOptions,
  type ModelOption,
  toChecklistEntries,
  toggleKey,
} from '../lib/modelOptions';
import { useAiLabStore } from '../store/useAiLabStore';
import type { AiLabProviderConfig } from '../types';

/**
 * Model-selection scaffolding shared by Playground / EvalBuilder / Arena:
 * flattened options, memoized checklist entries, and stable toggle/bulk
 * callbacks. Keeping this in one place is what keeps the memoized
 * ModelChecklist's referential-stability contract honoured in all three tabs
 * (the three inline copies had to stay in lockstep by hand).
 *
 * `onChange` MUST be referentially stable (wrap in useCallback) — it feeds
 * the memoized callbacks below.
 */
export function useModelSelection(
  providers: Record<string, AiLabProviderConfig>,
  selected: string[],
  onChange: (selected: string[]) => void
): {
  modelOptions: ModelOption[];
  checklistEntries: ModelChecklistEntry[];
  selectedSet: Set<string>;
  toggle: (key: string) => void;
  setSelected: (next: Set<string>) => void;
} {
  const favoriteModelKeys = useAiLabStore((state) => state.favoriteModelKeys);
  const recentModelKeys = useAiLabStore((state) => state.recentModelKeys);
  const modelOptions = useMemo(
    () => buildModelOptions(providers, { favoriteModelKeys, recentModelKeys }),
    [providers, favoriteModelKeys, recentModelKeys]
  );
  const checklistEntries = useMemo(() => toChecklistEntries(modelOptions), [modelOptions]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = useCallback(
    (key: string) => onChange(toggleKey(selected, key)),
    [selected, onChange]
  );
  const setSelected = useCallback((next: Set<string>) => onChange([...next]), [onChange]);
  return { modelOptions, checklistEntries, selectedSet, toggle, setSelected };
}
