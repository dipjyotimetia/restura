import { evidenceBytes, RESPONSE_EVIDENCE_LIMITS } from '@shared/collection-run/evidence';
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

function totalEvidenceBytes(runs: CollectionRunResult[]): number {
  return runs.reduce(
    (runTotal, item) =>
      runTotal +
      item.requests.reduce(
        (requestTotal, request) => requestTotal + evidenceBytes(request.evidence),
        0
      ),
    0
  );
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

  it('preserves metadata-only requests and skips evidence-free oldest runs during global eviction', () => {
    const size = Math.floor(RESPONSE_EVIDENCE_LIMITS.perRunBytes * 0.9);
    const runs = Array.from({ length: 12 }, (_, index) => run(`run-${index}`, 20 - index, size));
    runs[11] = {
      ...runs[11]!,
      requests: [
        ...runs[11]!.requests,
        {
          itemId: 'metadata-with-evidence',
          itemName: 'metadata-with-evidence',
          protocol: 'http',
          iteration: 0,
          status: 'success',
          assertions: [],
        },
      ],
    };
    const oldest: CollectionRunResult = {
      ...run('oldest', 0),
      requests: [
        {
          itemId: 'metadata-only',
          itemName: 'metadata-only',
          protocol: 'http',
          iteration: 0,
          status: 'success',
          assertions: [],
        },
      ],
    };

    const result = pruneCollectionRuns([...runs, oldest]);

    expect(result.at(-1)?.requests[0]?.evidence).toBeUndefined();
    expect(result.some((item) => item.requests[0]?.evidence?.unavailable)).toBe(true);
  });

  it('counts retained metadata after each global evidence eviction', () => {
    const targetPerRun = Math.floor(RESPONSE_EVIDENCE_LIMITS.totalBytes / 11);
    let excerptBytes = targetPerRun;
    for (let attempt = 0; attempt < 2; attempt++) {
      const actualBytes = totalEvidenceBytes([run('probe', 0, excerptBytes)]);
      excerptBytes -= actualBytes - targetPerRun;
    }
    const runs = Array.from({ length: 12 }, (_, index) =>
      run(`boundary-${index}`, 12 - index, excerptBytes)
    );

    expect(totalEvidenceBytes(runs)).toBeGreaterThan(RESPONSE_EVIDENCE_LIMITS.totalBytes);

    const result = pruneCollectionRuns(runs);

    expect(totalEvidenceBytes(result)).toBeLessThanOrEqual(RESPONSE_EVIDENCE_LIMITS.totalBytes);
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
