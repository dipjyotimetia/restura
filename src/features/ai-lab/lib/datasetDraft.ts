import type { Dataset, DatasetCase } from '../types';
import { plural } from './plural';
import { summarizeVars } from './summarizeVars';

/**
 * The dataset editor's work buffer + its (de)serialisation helpers. Lives in
 * lib (not the component) because the buffer itself is held in
 * useAiLabUiStore, like every other AI Lab tab draft — edits survive sub-tab
 * switches instead of silently vanishing on unmount.
 */

export type EditMode = 'structured' | 'json';

/** A case as edited in the UI (ids are minted/preserved on save). `turns` is
 *  carried opaquely so multi-turn cases survive structured-mode edits.
 *  `_key` is a UI-only stable identity so React state doesn't get recycled
 *  across row removals (index keys did); it is seeded from the persisted case
 *  id on load, so saving through it preserves case identity. */
export interface EditableCase {
  _key: string;
  vars: Record<string, string>;
  expected?: string;
  reference?: string;
  turns?: DatasetCase['turns'];
}

/** The Datasets tab's unsaved work buffer (session-scoped, never persisted). */
export interface DatasetDraft {
  /** Dataset this buffer belongs to — a mismatch means "reload from store". */
  datasetId: string;
  name: string;
  cases: EditableCase[];
  /** JSON-tab text; only materialised while `mode === 'json'`. */
  jsonText: string;
  mode: EditMode;
  dirty: boolean;
}

export type ParseResult = { ok: true; cases: EditableCase[] } | { ok: false; error: string };

export function normalizeCase(c: unknown): EditableCase {
  const obj = (c ?? {}) as Record<string, unknown>;
  const vars =
    obj.vars && typeof obj.vars === 'object' && !Array.isArray(obj.vars)
      ? (obj.vars as Record<string, string>)
      : {};
  return {
    _key: crypto.randomUUID(),
    vars,
    ...(typeof obj.expected === 'string' ? { expected: obj.expected } : {}),
    ...(typeof obj.reference === 'string' ? { reference: obj.reference } : {}),
    ...(obj.turns !== undefined ? { turns: obj.turns as DatasetCase['turns'] } : {}),
  };
}

export function parseCases(text: string): ParseResult {
  try {
    const arr = JSON.parse(text) as unknown;
    if (!Array.isArray(arr)) return { ok: false, error: 'not an array' };
    return { ok: true, cases: arr.map(normalizeCase) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Serialize for the JSON tab / persistence — the UI-only `_key` never leaks. */
export const serializeCases = (cs: EditableCase[]) =>
  JSON.stringify(
    cs.map(({ _key: _drop, ...rest }) => rest),
    null,
    2
  );

/** Build a fresh work buffer from a persisted dataset, keeping the edit mode. */
export function draftFromDataset(dataset: Dataset, mode: EditMode): DatasetDraft {
  const cases = dataset.cases.map(({ id, ...rest }) => ({ ...rest, _key: id }));
  return {
    datasetId: dataset.id,
    name: dataset.name,
    cases,
    // Serialize only when the JSON tab is showing — switching to it re-seeds
    // jsonText anyway, so eager pretty-printing of every case on each dataset
    // switch was pure waste in the (default) structured mode.
    jsonText: mode === 'json' ? serializeCases(cases) : '[]',
    mode,
    dirty: false,
  };
}

/** One-line summary for a collapsed case row. */
export function caseSummary(c: EditableCase): string {
  const varPairs = summarizeVars(c.vars, 3, 24);
  const parts: string[] = [varPairs || 'no variables'];
  if (c.expected) parts.push('expected ✓');
  if (c.reference) parts.push('reference ✓');
  if (c.turns) parts.push(plural(c.turns.length, 'turn'));
  return parts.join(' · ');
}
