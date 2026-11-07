/**
 * Export recorded load-test runs (Runs panel) as JSON or CSV. The stored
 * request is deliberately left out: its headers/auth can carry credentials,
 * and the URL has userinfo / credential query params redacted like history.
 */
import { redactUrlCredentialsForStorage } from '@shared/collections/postman/text-redaction';
import type { LoadTestRun } from '@/store/useLoadTestStore';

function toExportRow(run: LoadTestRun) {
  return {
    id: run.id,
    requestName: run.requestName,
    method: run.method,
    url: redactUrlCredentialsForStorage(run.url),
    completedAt: new Date(run.completedAt).toISOString(),
    rps: run.rps,
    stats: run.stats,
  };
}

export function renderLoadRunsJson(runs: readonly LoadTestRun[]): string {
  return JSON.stringify(runs.map(toExportRow), null, 2);
}

const CSV_COLUMNS = [
  'id',
  'requestName',
  'method',
  'url',
  'completedAt',
  'count',
  'errors',
  'rps',
  'min',
  'mean',
  'p50',
  'p90',
  'p95',
  'p99',
  'max',
] as const;

function csvField(value: string | number): string {
  let text = String(value);
  // A text cell starting with = + - @ (or tab/CR) runs as a formula in
  // spreadsheet apps; prefix a quote so it stays text (numbers are left alone).
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r']/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderLoadRunsCsv(runs: readonly LoadTestRun[]): string {
  const rows = runs.map((run) => {
    const row = toExportRow(run);
    const values: Record<(typeof CSV_COLUMNS)[number], string | number> = {
      id: row.id,
      requestName: row.requestName,
      method: row.method,
      url: row.url,
      completedAt: row.completedAt,
      count: run.stats.count,
      errors: run.stats.errors,
      rps: run.rps,
      min: run.stats.min,
      mean: run.stats.mean,
      p50: run.stats.p50,
      p90: run.stats.p90,
      p95: run.stats.p95,
      p99: run.stats.p99,
      max: run.stats.max,
    };
    return CSV_COLUMNS.map((column) => csvField(values[column])).join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}
