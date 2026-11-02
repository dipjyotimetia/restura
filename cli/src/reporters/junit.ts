import { writeFile } from 'node:fs/promises';
import type { Reporter, RunResult } from './types.js';

/**
 * Writes a JUnit XML report compatible with most CI systems (Jenkins,
 * GitLab CI, CircleCI, GitHub Actions test reporting actions, etc.).
 *
 * Each request becomes a `<testcase>`. Non-2xx responses become `<failure>`,
 * fetcher / network errors become `<error>`, and the surrounding `<testsuite>`
 * carries the aggregate counts for at-a-glance CI dashboards.
 */
export class JUnitReporter implements Reporter {
  constructor(private outputPath: string) {}

  async onEnd(result: RunResult): Promise<void> {
    await writeFile(this.outputPath, renderJUnitXml(result), 'utf-8');
  }
}

/**
 * Strip XML-1.0-illegal control chars (upstream error bodies can carry them and
 * make the document non-well-formed), then entity-escape.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderJUnitXml(result: RunResult): string {
  const ms = (n: number) => (n / 1000).toFixed(3);

  const failureDetail = (r: RunResult['requests'][number]): string => {
    const failed = (r.assertions ?? []).filter((a) => !a.passed);
    if (failed.length === 0) return '';
    return failed.map((a) => `${a.name}${a.error ? `: ${a.error}` : ''}`).join('\n');
  };

  const cases = result.requests
    .map((r) => {
      const cls = escapeXml(r.request.type);
      // Disambiguate data-driven iterations — without this, N rows of the same
      // request collapse to identical classname.name and CI consumers drop all
      // but one.
      const suffix = r.iteration !== undefined ? ` [iter ${r.iteration}]` : '';
      const name = escapeXml(r.request.request.name + suffix);
      const time = ms(r.durationMs);
      const failed = (r.assertions ?? []).filter((a) => !a.passed);

      if (r.errorMessage) {
        const detail = escapeXml([r.errorMessage, failureDetail(r)].filter(Boolean).join('\n'));
        return `    <testcase classname="${cls}" name="${name}" time="${time}"><error message="${escapeXml(r.errorMessage)}">${detail}</error></testcase>`;
      }
      if (!r.passed) {
        const msg = failed.length > 0 ? `${failed.length} assertion(s) failed` : `HTTP ${r.status}`;
        const detail = escapeXml(failureDetail(r));
        return `    <testcase classname="${cls}" name="${name}" time="${time}"><failure message="${escapeXml(msg)}">${detail}</failure></testcase>`;
      }
      return `    <testcase classname="${cls}" name="${name}" time="${time}"/>`;
    })
    .join('\n');

  const timestamp = new Date(result.meta.startedAt).toISOString();

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="${escapeXml(result.meta.collectionName)}" tests="${result.summary.total}" failures="${result.summary.failed}" errors="${result.summary.errored}" time="${ms(result.durationMs)}">`,
    `  <testsuite name="${escapeXml(result.meta.collectionName)}" tests="${result.summary.total}" failures="${result.summary.failed}" errors="${result.summary.errored}" time="${ms(result.durationMs)}" timestamp="${timestamp}">`,
    cases,
    `  </testsuite>`,
    `</testsuites>`,
  ].join('\n');
}
