import { redactDiagnosticText } from '@shared/collection-run/evidence';
import type { CollectionRunResult } from './collectionRunner';

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!
  );
}

/** Sanitized, portable report shape. It intentionally contains no request or variable values. */
export function collectionRunReport(run: CollectionRunResult) {
  return {
    schemaVersion: 1,
    kind: 'restura.collection-run',
    id: run.id,
    collection: { id: run.collectionId, name: run.collectionName, scope: run.scopeName },
    startedAt: new Date(run.startedAt).toISOString(),
    durationMs: run.durationMs,
    outcome: run.outcome,
    summary: run.summary,
    configuration: run.configuration,
    requests: run.requests.map((request) => ({
      itemId: request.itemId,
      itemName: request.itemName,
      protocol: request.protocol,
      iteration: request.iteration,
      status: request.status,
      httpStatus: request.httpStatus,
      durationMs: request.durationMs,
      sizeBytes: request.sizeBytes,
      skippedReason: request.skippedReason
        ? redactDiagnosticText(request.skippedReason)
        : undefined,
      error: request.error ? redactDiagnosticText(request.error) : undefined,
      assertions: request.assertions.map((assertion) => ({
        name: assertion.name,
        passed: assertion.passed,
        error: assertion.error ? redactDiagnosticText(assertion.error) : undefined,
      })),
      evidence: request.evidence,
    })),
  };
}

export function renderCollectionRunJson(run: CollectionRunResult): string {
  return `${JSON.stringify(collectionRunReport(run), null, 2)}\n`;
}

export function renderCollectionRunJUnit(run: CollectionRunResult): string {
  const report = collectionRunReport(run);
  const failures = report.requests.filter((request) => request.status === 'failed').length;
  const skipped = report.requests.filter((request) => request.status === 'skipped').length;
  const cases = report.requests
    .map((request) => {
      const attrs = `name="${escapeXml(request.itemName)}" classname="${escapeXml(request.protocol)}" time="${(
        (request.durationMs ?? 0) / 1000
      ).toFixed(3)}"`;
      if (request.status === 'skipped') return `<testcase ${attrs}><skipped/></testcase>`;
      if (request.status === 'failed') {
        const message =
          request.error ?? request.assertions.find((a) => !a.passed)?.error ?? 'Request failed';
        return `<testcase ${attrs}><failure message="${escapeXml(message)}"/></testcase>`;
      }
      return `<testcase ${attrs}/>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(report.collection.scope)}" tests="${report.requests.length}" failures="${failures}" skipped="${skipped}" time="${(
    report.durationMs / 1000
  ).toFixed(3)}">${cases}</testsuite>\n`;
}

export function renderCollectionRunHtml(run: CollectionRunResult): string {
  const report = collectionRunReport(run);
  const rows = report.requests
    .map(
      (request) =>
        `<tr><td>${escapeXml(request.itemName)}</td><td>${escapeXml(request.protocol)}</td><td>${escapeXml(request.status)}</td><td>${request.httpStatus ?? ''}</td><td>${request.durationMs ?? ''}</td><td>${escapeXml(request.error ?? '')}</td></tr>`
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>${escapeXml(report.collection.scope)} — Restura run</title><style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.4rem;text-align:left}</style><h1>${escapeXml(report.collection.scope)}</h1><p>${report.summary.passed} passed · ${report.summary.failed} failed · ${report.durationMs}ms</p><table><thead><tr><th>Request</th><th>Protocol</th><th>Outcome</th><th>Status</th><th>ms</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>`;
}
