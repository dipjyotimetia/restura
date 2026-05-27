import Papa from 'papaparse';

/**
 * One iteration's worth of data-file variables. All values are coerced to
 * strings because the variable-substitution layer (`{{var}}`) is string-based.
 * Mirrors the CLI's `IterationRow` (`cli/src/runner/dataLoader.ts`) but reads
 * from a browser `File`/string instead of `node:fs`.
 */
export type IterationRow = Record<string, string>;

function coerceRow(row: Record<string, unknown>): IterationRow {
  const out: IterationRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === '') continue;
    if (value === null || value === undefined) {
      out[key] = '';
    } else if (typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/** Parse a JSON array-of-objects into iteration rows. */
function parseJson(text: string): IterationRow[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('JSON data file must be an array of objects');
  }
  return parsed.map((row) => coerceRow(row as Record<string, unknown>));
}

/** Parse CSV (first row = headers) into iteration rows via papaparse. */
function parseCsv(text: string): IterationRow[] {
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  // 'Delimiter' errors are papaparse's auto-detect fallback warning (e.g. a
  // single-column file) — non-fatal; it still parses. Only surface real errors.
  const fatal = result.errors.filter((e) => e.type !== 'Delimiter');
  if (fatal.length > 0) {
    throw new Error(`CSV parse error: ${fatal[0]?.message ?? 'unknown'}`);
  }
  return result.data.map(coerceRow);
}

/**
 * Parse raw data-file text into iteration rows. `format` is auto-detected from
 * the leading non-whitespace character when omitted (`[` ⇒ JSON, else CSV).
 */
export function parseDataFile(text: string, format?: 'csv' | 'json'): IterationRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const kind = format ?? (trimmed.startsWith('[') ? 'json' : 'csv');
  return kind === 'json' ? parseJson(trimmed) : parseCsv(trimmed);
}

/** Read + parse a picked `File`, inferring format from its extension. */
export async function loadDataFile(file: File): Promise<IterationRow[]> {
  const text = await file.text();
  const ext = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
  return parseDataFile(text, ext);
}
