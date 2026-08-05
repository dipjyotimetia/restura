import { describe, expect, it } from 'vitest';
import {
  collectionRunReport,
  renderCollectionRunHtml,
  renderCollectionRunJson,
  renderCollectionRunJUnit,
} from '../collectionRunExport';
import type { CollectionRunResult } from '../collectionRunner';

const run: CollectionRunResult = {
  id: 'run',
  collectionId: 'collection',
  collectionName: 'Collection',
  scopeName: 'Collection',
  startedAt: 0,
  durationMs: 10,
  iterations: 1,
  dataRows: 0,
  outcome: 'completed',
  summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
  requests: [
    {
      itemId: 'request',
      itemName: 'Request',
      protocol: 'http',
      iteration: 0,
      status: 'failed',
      assertions: [],
      error: 'Bearer secret-value-12345678',
    },
  ],
};

describe('collection run exports', () => {
  it('redacts diagnostic errors in JSON and JUnit exports', () => {
    expect(renderCollectionRunJson(run)).not.toContain('secret-value-12345678');
    expect(renderCollectionRunJUnit(run)).not.toContain('secret-value-12345678');
  });

  it('represents skipped requests, assertion failures, fallbacks, and optional metrics safely', () => {
    const reportRun: CollectionRunResult = {
      ...run,
      collectionName: '<Collection>',
      scopeName: 'Scope & Name',
      requests: [
        {
          itemId: 'skipped',
          itemName: '<Skipped>',
          protocol: 'http',
          iteration: 0,
          status: 'skipped',
          assertions: [],
          skippedReason: 'Bearer skipped-secret-12345678',
        },
        {
          itemId: 'assertion-failure',
          itemName: 'Assertion failure',
          protocol: 'http',
          iteration: 0,
          status: 'failed',
          assertions: [
            {
              name: 'assertion',
              passed: false,
              error: 'Bearer assertion-secret-12345678',
            },
          ],
        },
        {
          itemId: 'fallback-failure',
          itemName: 'Fallback failure',
          protocol: 'http',
          iteration: 0,
          status: 'failed',
          assertions: [],
        },
        {
          itemId: 'success',
          itemName: 'Success',
          protocol: 'http',
          iteration: 0,
          status: 'success',
          assertions: [{ name: 'passed assertion', passed: true }],
        },
      ],
    };

    const report = collectionRunReport(reportRun);
    expect(report.requests[0]).toMatchObject({
      skippedReason: '[REDACTED]',
      error: undefined,
    });
    expect(report.requests[1]?.assertions[0]).toMatchObject({ error: '[REDACTED]' });

    const junit = renderCollectionRunJUnit(reportRun);
    expect(junit).toContain('<skipped/>');
    expect(junit).toContain('message="[REDACTED]"');
    expect(junit).toContain('message="Request failed"');

    const html = renderCollectionRunHtml(reportRun);
    expect(html).toContain('&lt;Skipped&gt;');
    expect(html).toContain('<td></td><td></td><td></td>');
    expect(html).not.toContain('skipped-secret-12345678');
  });
});
