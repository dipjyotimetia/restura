// Flatten an EvalRun into shareable report formats (CSV / JSON / Markdown).
// Pure — the ReportView wires download buttons to these.
import Papa from 'papaparse';
import type { EvalRun, EvalCellResult } from '../types';

function modelLabel(cell: EvalCellResult): string {
  return cell.modelRef.model || `${cell.modelRef.providerConfigId}:${cell.modelRef.model}`;
}

/** One row per cell: case, model, pass, latency, cost, scorer summary. */
export function runToCsv(run: EvalRun): string {
  const header = [
    'caseId',
    'model',
    'passed',
    'notEvaluated',
    'latencyMs',
    'cost',
    'scores',
    'error',
  ];
  const rows = run.cells.map((cell) => {
    const scores = cell.scores
      .map(
        (s) =>
          `${s.kind}:${s.passed ? 'pass' : 'fail'}${s.score !== undefined ? `(${s.score.toFixed(2)})` : ''}`
      )
      .join(' ');
    return [
      cell.caseId,
      modelLabel(cell),
      String(cell.passed),
      String(cell.notEvaluated ?? false),
      String(Math.round(cell.latencyMs)),
      cell.cost === null ? '' : String(cell.cost),
      scores,
      cell.error ?? '',
    ];
  });
  return Papa.unparse([header, ...rows]);
}

/** Full structured export (the run object verbatim, pretty-printed). */
export function runToJson(run: EvalRun): string {
  return JSON.stringify(run, null, 2);
}

/** Human-readable Markdown summary: per-model pass rates + a cells table. */
export function runToMarkdown(run: EvalRun): string {
  const lines: string[] = [];
  lines.push(`# Eval report: ${run.configName}`);
  lines.push('');
  lines.push(`- Status: ${run.status}`);
  lines.push(`- Cells: ${run.cells.length}/${run.totalCells}`);
  lines.push('');

  // Per-model pass rate. notEvaluated cells (no scorers) are excluded from the
  // denominator — they're neither pass nor fail.
  const byModel = new Map<string, { passed: number; total: number }>();
  for (const cell of run.cells) {
    if (cell.notEvaluated) continue;
    const label = modelLabel(cell);
    const e = byModel.get(label) ?? { passed: 0, total: 0 };
    e.total++;
    if (cell.passed) e.passed++;
    byModel.set(label, e);
  }
  lines.push('## Pass rate by model');
  lines.push('');
  lines.push('| Model | Pass rate |');
  lines.push('| --- | --- |');
  for (const [label, e] of byModel) {
    const rate = e.total ? Math.round((e.passed / e.total) * 100) : 0;
    lines.push(`| ${label} | ${rate}% (${e.passed}/${e.total}) |`);
  }
  lines.push('');

  lines.push('## Cells');
  lines.push('');
  lines.push('| Case | Model | Passed | Latency | Scores |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const cell of run.cells) {
    const scores = cell.scores.map((s) => `${s.kind}:${s.passed ? '✓' : '✗'}`).join(' ');
    const status = cell.notEvaluated ? '—' : cell.passed ? '✓' : '✗';
    lines.push(
      `| ${cell.caseId} | ${modelLabel(cell)} | ${status} | ${Math.round(cell.latencyMs)}ms | ${scores} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}
