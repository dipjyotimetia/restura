import { RESPONSE_EVIDENCE_LIMITS } from '@shared/collection-run/evidence';
import { describe, expect, it } from 'vitest';
import type { CollectionRunResult } from '@/features/collections/lib/collectionRunner';
import { runMigrations } from '@/lib/shared/persistence/runMigrations';
import { collectionRunMigrationDescriptor, pruneCollectionRuns } from '../useCollectionRunStore';

function run(id: string, startedAt: number, evidenceSize = 0): CollectionRunResult {
  return {
    id,
    collectionId: 'collection',
    collectionName: 'Collection',
    scopeName: 'Collection',
    startedAt,
    durationMs: 1,
    iterations: 1,
    dataRows: 0,
    outcome: 'completed',
    requests: evidenceSize
      ? [
          {
            itemId: id,
            itemName: id,
            protocol: 'http',
            iteration: 0,
            status: 'success',
            assertions: [],
            evidence: {
              contentType: 'text/plain',
              sizeBytes: evidenceSize,
              headers: {},
              excerpt: 'x'.repeat(evidenceSize),
              truncated: false,
              redacted: false,
              binary: false,
              unavailable: false,
            },
          },
        ]
      : [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
  };
}

describe('pruneCollectionRuns', () => {
  it('keeps newest runs first and evicts oldest evidence until under the total budget', () => {
    const size = Math.floor(RESPONSE_EVIDENCE_LIMITS.totalBytes * 0.45);
    const result = pruneCollectionRuns([
      run('new', 3, size),
      run('middle', 2, size),
      run('old', 1, size),
    ]);

    expect(result.map((item) => item.id)).toEqual(['new', 'middle', 'old']);
    expect(result[2]!.requests[0]!.evidence).toMatchObject({ unavailable: true });
  });

  it('strips per-run evidence deterministically instead of discarding the completed run', () => {
    const result = pruneCollectionRuns([
      run('oversized', 1, RESPONSE_EVIDENCE_LIMITS.perRunBytes + 1),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.requests[0]!.evidence).toMatchObject({ unavailable: true });
    expect(result[0]!.requests[0]!.evidence?.excerpt).toBeUndefined();
  });
});

describe('collection-run persistence migration', () => {
  it('preserves legacy run metadata while advancing the evidence store version', () => {
    const outcome = runMigrations(
      collectionRunMigrationDescriptor,
      { runs: [run('legacy', 1)] },
      1
    );

    expect(outcome).toMatchObject({ kind: 'ok', from: 1, to: 2 });
    if (outcome.kind === 'ok') {
      expect((outcome.state as { runs: CollectionRunResult[] }).runs[0]?.id).toBe('legacy');
    }
  });
});
