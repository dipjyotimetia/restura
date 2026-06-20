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
 * Returns an empty array when no file was provided.
 */
export async function loadIterationData(path: string | undefined): Promise<CliIterationRow[]> {
  if (!path) return [];
  const ext = extname(path).toLowerCase();
  const text = await readFile(path, 'utf-8');

  if (ext === '.json') {
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
        out[k] = v === null || v === undefined ? '' : String(v);
      }
      return out;
    });
  }

  // CSV (default for .csv and anything else)
  const records = parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, string>>;
  return records.map((row) => {
    const out: CliIterationRow = {};
    for (const [k, v] of Object.entries(row)) out[k] = String(v ?? '');
    return out;
  });
}
