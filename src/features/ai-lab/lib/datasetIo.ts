// Dataset import/export to/from CSV and JSONL. Pure string<->case conversion so
// the editor (and tests) can round-trip a dataset without touching the store.
//
// JSONL: one JSON object per line, each `{ vars, expected?, reference?, turns? }`.
// CSV: a header row; an `expected`/`reference` column maps to those fields, every
// other column becomes a `vars.<column>` entry. (Multi-turn isn't expressible in
// flat CSV — use JSONL for that.)
import Papa from 'papaparse';
import type { DatasetCase } from '../types';

export type DatasetCaseInput = Omit<DatasetCase, 'id'>;

// --- JSONL -----------------------------------------------------------------

export function casesToJsonl(cases: DatasetCaseInput[]): string {
  return cases.map((c) => JSON.stringify(c)).join('\n');
}

export function casesFromJsonl(text: string): DatasetCaseInput[] {
  const out: DatasetCaseInput[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`invalid JSONL line: ${trimmed.slice(0, 60)}`);
    }
    out.push(coerceCase(parsed));
  }
  return out;
}

// --- CSV --------------------------------------------------------------------
// Quoting/parsing delegated to papaparse (same dependency the response-viewer
// CSV path uses, src/lib/shared/csvParser.ts) so there's one CSV implementation.

/** Serialize cases to CSV. `vars` keys across all cases form the var columns. */
export function casesToCsv(cases: DatasetCaseInput[]): string {
  const varKeys = new Set<string>();
  for (const c of cases) for (const k of Object.keys(c.vars ?? {})) varKeys.add(k);
  const cols = [...varKeys, 'expected', 'reference'];
  const rows = cases.map((c) =>
    cols.map((col) => {
      if (col === 'expected') return c.expected ?? '';
      if (col === 'reference') return c.reference ?? '';
      return c.vars?.[col] ?? '';
    })
  );
  return Papa.unparse([cols, ...rows]);
}

export function casesFromCsv(text: string): DatasetCaseInput[] {
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: 'greedy' });
  const rows = (parsed.data ?? []).filter((r): r is string[] => Array.isArray(r));
  const header = rows[0];
  if (!header) return [];
  const out: DatasetCaseInput[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const vars: Record<string, string> = {};
    let expected: string | undefined;
    let reference: string | undefined;
    header.forEach((col, idx) => {
      const val = row[idx] ?? '';
      if (col === 'expected') expected = val;
      else if (col === 'reference') reference = val;
      else vars[col] = val;
    });
    out.push({
      vars,
      ...(expected !== undefined && expected !== '' ? { expected } : {}),
      ...(reference !== undefined && reference !== '' ? { reference } : {}),
    });
  }
  return out;
}

// --- helpers ----------------------------------------------------------------

function coerceCase(v: unknown): DatasetCaseInput {
  const obj = (v ?? {}) as Record<string, unknown>;
  const vars: Record<string, string> = {};
  if (obj.vars && typeof obj.vars === 'object') {
    for (const [k, val] of Object.entries(obj.vars as Record<string, unknown>)) {
      vars[k] = typeof val === 'string' ? val : JSON.stringify(val);
    }
  }
  const out: DatasetCaseInput = { vars };
  if (typeof obj.expected === 'string') out.expected = obj.expected;
  if (typeof obj.reference === 'string') out.reference = obj.reference;
  if (Array.isArray(obj.turns)) {
    const turns = obj.turns
      .filter((t): t is { role: string; content: string } => !!t && typeof t === 'object')
      .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
      .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content }));
    if (turns.length) out.turns = turns;
  }
  return out;
}
