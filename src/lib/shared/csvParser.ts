/**
 * CSV parsing + detection for the response viewer's Table view.
 *
 * Detection is deliberately conservative: an explicit `text/csv` (or tsv)
 * content type always qualifies, and otherwise we sniff a `text/plain` /
 * unknown body for a consistent delimiter across its first few lines. This
 * catches APIs that serve CSV as `text/plain` without false-positiving on prose.
 */
import Papa from 'papaparse';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  /** True when rows were capped (very large CSV) — the viewer notes this. */
  truncated: boolean;
  totalRows: number;
}

/** Hard cap so a multi-MB CSV can't materialise an unbounded array in memory. */
const MAX_ROWS = 5000;
const SNIFF_LINES = 5;
const DELIMITERS = [',', '\t', ';', '|'] as const;

function contentTypeIsCsv(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const essence = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    essence === 'text/csv' ||
    essence === 'application/csv' ||
    essence === 'text/tab-separated-values'
  );
}

/**
 * Heuristic for delimiter-separated text masquerading as text/plain.
 * Requires ≥2 lines, each carrying the same (non-zero) count of a single
 * delimiter — which prose almost never satisfies.
 */
export function looksLikeCsv(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, SNIFF_LINES);
  if (lines.length < 2) return false;

  for (const delim of DELIMITERS) {
    const counts = lines.map((l) => l.split(delim).length - 1);
    const first = counts[0] ?? 0;
    if (first >= 1 && counts.every((c) => c === first)) return true;
  }
  return false;
}

/**
 * Whether to offer a CSV table for this response. Explicit CSV content types
 * always qualify; text/plain (or absent) bodies must pass the sniff test.
 */
export function isCsvResponse(contentType: string | undefined, body: string): boolean {
  if (contentTypeIsCsv(contentType)) return true;
  const essence = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const plainish = essence === '' || essence === 'text/plain';
  return plainish && looksLikeCsv(body);
}

export function parseCsv(body: string): ParsedCsv {
  const result = Papa.parse<string[]>(body.trim(), {
    skipEmptyLines: 'greedy',
    // Tab/semicolon/pipe are auto-detected by Papa when delimiter is empty.
    delimiter: '',
  });

  const data = (result.data ?? []).filter((row) => Array.isArray(row));
  const totalRows = Math.max(0, data.length - 1);
  const headers = (data[0] as string[] | undefined) ?? [];
  const bodyRows = data.slice(1, 1 + MAX_ROWS) as string[][];

  return {
    headers,
    rows: bodyRows,
    truncated: totalRows > MAX_ROWS,
    totalRows,
  };
}
