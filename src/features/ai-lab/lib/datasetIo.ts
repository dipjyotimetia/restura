// Dataset import/export to/from CSV and JSONL. Pure string<->case conversion so
// the editor (and tests) can round-trip a dataset without touching the store.
//
// JSONL: one JSON object per line, each `{ vars, expected?, reference?, turns? }`.
// CSV: a header row; an `expected`/`reference` column maps to those fields, every
// other column becomes a `vars.<column>` entry. (Multi-turn isn't expressible in
// flat CSV — use JSONL for that.)
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

/** Serialize cases to CSV. `vars` keys across all cases form the var columns. */
export function casesToCsv(cases: DatasetCaseInput[]): string {
  const varKeys = new Set<string>();
  for (const c of cases) for (const k of Object.keys(c.vars ?? {})) varKeys.add(k);
  const cols = [...varKeys, 'expected', 'reference'];
  const rows = [cols.map(csvEscape).join(',')];
  for (const c of cases) {
    const cells = cols.map((col) => {
      if (col === 'expected') return csvEscape(c.expected ?? '');
      if (col === 'reference') return csvEscape(c.reference ?? '');
      return csvEscape(c.vars?.[col] ?? '');
    });
    rows.push(cells.join(','));
  }
  return rows.join('\n');
}

export function casesFromCsv(text: string): DatasetCaseInput[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  const out: DatasetCaseInput[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length === 1 && row[0] === '') continue; // blank line
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

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Minimal RFC-4180 CSV parser (handles quoted fields, escaped quotes, newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // swallow; \n handles row break
    } else {
      field += ch;
    }
  }
  // flush last field/row if any content
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
