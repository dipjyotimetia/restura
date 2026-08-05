import { describe, expect, it } from 'vitest';
import { renderCollectionRunJson, renderCollectionRunJUnit } from '../collectionRunExport';
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
});
