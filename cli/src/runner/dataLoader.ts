import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';

export type CliIterationRow = Record<string, string>;

/**
 * Load `--data <file>` for data-driven runs. Each row becomes one iteration;
 * keys are exposed as variables (overriding env/collection variables for that
 * iteration only). Supports CSV (with a header row) and JSON arrays of
 * objects. JSON values are coerced to strings — variable substitution is
 * string-only.
 *
 * Returns an empty array when no file was provided. A file that was provided
 * but holds no rows (`[]`, a header-only CSV, a blank file) is an error: the
 * run would otherwise silently do one iteration with no row, which is not what
 * `--data` asked for.
 *
 * The format follows the extension (`.json` is JSON, `.csv` is CSV); any other
 * extension is sniffed like the app's `parseDataFile` (a leading `[` means
 * JSON, otherwise CSV). A ragged CSV row is an error, as in the app (papaparse
 * reports `FieldMismatch` and the app refuses it). CSV matches the app's
 * papaparse settings: the delimiter (`,` `;` tab `|`) is detected from the
 * header line and values keep their surrounding whitespace.
 */
export async function loadIterationData(path: string | undefined): Promise<CliIterationRow[]> {
  if (!path) return [];
  const rows = await parseIterationFile(path);
  if (rows.length === 0) {
    throw new Error(`--data file has no rows: ${path}`);
  }
  return rows;
}

async function parseIterationFile(path: string): Promise<CliIterationRow[]> {
  const extension = extname(path).toLowerCase();
  // A UTF-8 BOM (Excel exports) would break JSON.parse and the first CSV header.
  const text = (await readFile(path, 'utf-8')).replace(/^﻿/, '');
  const isJson =
    extension === '.json' || (extension !== '.csv' && text.trimStart().startsWith('['));

  if (isJson) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(`--data file must be a JSON array of objects: ${path}`);
    }
    return parsed.map((row, idx) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`--data row ${idx} must be an object`);
      }
      const out: CliIterationRow = {};
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        if (k === '') continue;
        // Same coercion as the app (`coerceRow`): nested values stay JSON, so a
        // `{{payload}}` body is not sent as "[object Object]".
        out[k] =
          v === null || v === undefined
            ? ''
            : typeof v === 'object'
              ? JSON.stringify(v)
              : String(v);
      }
      return out;
    });
  }

  // CSV (default for .csv and anything that does not look like JSON)
  let records: Array<Record<string, string>>;
  try {
    // Same shape as the app's `Papa.parse(text, { header: true, skipEmptyLines:
    // true })`: the delimiter is detected, and values are not trimmed.
    records = parseCsv(text, {
      columns: true,
      skip_empty_lines: true,
      delimiter: detectCsvDelimiter(text),
    }) as Array<Record<string, string>>;
  } catch (err) {
    throw new Error(
      `--data CSV parse error (${path}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return records.map((row) => {
    const out: CliIterationRow = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === '') continue; // the app's `coerceRow` drops an unnamed column
      out[k] = String(v ?? '');
    }
    return out;
  });
}

/** Candidates in papaparse's auto-detect preference order (a tie keeps the earlier one). */
const CSV_DELIMITERS = [',', '\t', '|', ';'] as const;

/**
 * The delimiter of a CSV file, detected from its header line like the app's
 * papaparse auto-detection: the candidate that occurs most often outside
 * quotes, defaulting to `,` (a single-column file).
 */
export function detectCsvDelimiter(text: string): string {
  const counts = new Map<string, number>(CSV_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"') {
      // A doubled quote inside a quoted field is an escaped quote.
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') break;
    const n = counts.get(ch);
    if (n !== undefined) counts.set(ch, n + 1);
  }
  let best: string = ',';
  let bestCount = 0;
  for (const d of CSV_DELIMITERS) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}
