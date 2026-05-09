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

export function renderJUnitXml(result: RunResult): string {
  const ms = (n: number) => (n / 1000).toFixed(3);
  const escape = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const cases = result.requests
    .map((r) => {
      const cls = escape(r.request.type);
      const name = escape(r.request.request.name);
      const time = ms(r.durationMs);
      if (r.errorMessage) {
        return `    <testcase classname="${cls}" name="${name}" time="${time}"><error message="${escape(r.errorMessage)}"></error></testcase>`;
      }
      if (!r.passed) {
        return `    <testcase classname="${cls}" name="${name}" time="${time}"><failure message="HTTP ${r.status}"></failure></testcase>`;
      }
      return `    <testcase classname="${cls}" name="${name}" time="${time}"/>`;
    })
    .join('\n');

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="${escape(result.meta.collectionName)}" tests="${result.summary.total}" failures="${result.summary.failed}" errors="${result.summary.errored}" time="${ms(result.durationMs)}">`,
    `  <testsuite name="${escape(result.meta.collectionName)}" tests="${result.summary.total}" failures="${result.summary.failed}" errors="${result.summary.errored}" time="${ms(result.durationMs)}">`,
    cases,
    `  </testsuite>`,
    `</testsuites>`,
  ].join('\n');
}
