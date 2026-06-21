import { writeFile } from 'node:fs/promises';
import type { Reporter, RunResult } from './types.js';

/**
 * Writes a self-contained HTML report — single file, inline CSS, no external
 * fetches. Designed to be uploaded as a CI artifact and opened directly in a
 * browser. The full RunResult is also embedded as a `<script
 * type="application/json">` block so downstream tooling can re-parse without
 * needing the JSON reporter alongside.
 */
export class HtmlReporter implements Reporter {
  constructor(private outputPath: string) {}

  async onEnd(result: RunResult): Promise<void> {
    await writeFile(this.outputPath, renderHtml(result), 'utf-8');
  }
}

/**
 * Escape JSON that's about to be embedded inside `<script type="application/json">`.
 *
 * Without this, a request name like `</script><script>evil()</script>` would
 * pass through `JSON.stringify` unchanged, breaking out of the JSON island and
 * executing as JS in the browser. Escaping `<` and `>` to their unicode escapes
 * keeps the string a valid JSON literal while preventing parser breakout — it
 * survives `JSON.parse(...)` round-trip identically.
 */
function escapeJsonForHtml(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function renderHtml(result: RunResult): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const rows = result.requests
    .map((r) => {
      const statusClass = r.passed ? 'pass' : r.errorMessage ? 'err' : 'fail';
      const statusText = r.errorMessage ? 'ERROR' : String(r.status);
      const errorRow = r.errorMessage ? `<div class="err-msg">${escape(r.errorMessage)}</div>` : '';
      const method =
        (r.request.request as { method?: string }).method ?? r.request.type.toUpperCase();
      return `
    <tr class="${statusClass}">
      <td>${escape(r.request.request.name)}</td>
      <td>${escape(method)}</td>
      <td><code>${escape(r.request.relativePath)}</code></td>
      <td class="status">${statusText}</td>
      <td>${r.durationMs}ms</td>
    </tr>
    ${errorRow ? `<tr class="${statusClass}-detail"><td colspan="5">${errorRow}</td></tr>` : ''}`;
    })
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${escape(result.meta.collectionName)} — Restura CLI Report</title>
<style>
:root { color-scheme: light dark; }
body { font: 14px/1.45 system-ui, -apple-system, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid #8884; padding-bottom: 1rem; margin-bottom: 1rem; }
h1 { margin: 0; font-size: 1.5rem; }
.summary { font-size: 0.9rem; color: #888; }
.summary .pass { color: #22c55e; font-weight: 600; }
.summary .fail { color: #ef4444; font-weight: 600; }
.summary .err { color: #f59e0b; font-weight: 600; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #8882; }
th { font-weight: 600; font-size: 0.85rem; text-transform: uppercase; color: #888; }
tr.pass .status { color: #22c55e; }
tr.fail .status { color: #ef4444; }
tr.err .status { color: #f59e0b; }
.err-msg { background: #ef44441a; padding: 0.5rem; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.85rem; }
code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.85rem; }
</style></head>
<body>
<header>
  <h1>${escape(result.meta.collectionName)}</h1>
  <div class="summary">
    <span class="pass">${result.summary.passed} passed</span> ·
    <span class="fail">${result.summary.failed} failed</span> ·
    <span class="err">${result.summary.errored} errored</span>
    · ${(result.durationMs / 1000).toFixed(2)}s total
  </div>
</header>
<table>
  <thead>
    <tr><th>Name</th><th>Method</th><th>Path</th><th>Status</th><th>Time</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<script type="application/json" id="results">${escapeJsonForHtml(JSON.stringify(result))}</script>
</body></html>`;
}
