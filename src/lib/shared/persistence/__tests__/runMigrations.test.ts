/**
 * @vitest-environment node
 *
 * Pure-function unit tests for `runMigrations` (Gap #6). No IDB / Dexie /
 * zustand — fixture state in, MigrationOutcome out.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runMigrations } from '../runMigrations';
import type { MigrationDescriptor, MigrationStep } from '../types';

const exampleDescriptor: MigrationDescriptor<{ count: number; label: string }> = {
  store: 'settings',
  persistName: 'example-storage',
  version: 2,
  steps: [
    {
      name: 'add-count',
      fromVersion: 0,
      apply: (state) => {
        const s = (state ?? {}) as { label?: string };
        return { state: { count: 0, label: s.label ?? 'default' } };
      },
    },
    {
      name: 'rename-label',
      fromVersion: 1,
      apply: (state) => {
        const s = state as { count: number; label: string };
        return { state: { ...s, label: s.label.toUpperCase() }, lossy: [] };
      },
    },
  ],
  schema: z.object({ count: z.number(), label: z.string() }),
};

/** Identity step that records the version it ran from. */
const trackedStep = (ran: number[], name: string, fromVersion: number): MigrationStep => ({
  name,
  fromVersion,
  apply: (state) => {
    ran.push(fromVersion);
    return { state };
  },
});

describe('runMigrations', () => {
  it('returns noop for empty persisted state', () => {
    const result = runMigrations(exampleDescriptor, null, null);
    expect(result.kind).toBe('noop');
  });

  it('applies steps from v0 to v2 sequentially', () => {
    const result = runMigrations(exampleDescriptor, { label: 'hello' }, 0);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.applied).toEqual(['add-count', 'rename-label']);
    expect(result.state).toEqual({ count: 0, label: 'HELLO' });
    expect(result.to).toBe(2);
  });

  it('skips already-applied steps', () => {
    const result = runMigrations(exampleDescriptor, { count: 5, label: 'mid' }, 1);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.applied).toEqual(['rename-label']);
    expect(result.state).toEqual({ count: 5, label: 'MID' });
  });

  it('quarantines on schema failure', () => {
    const bad: MigrationDescriptor<{ count: number; label: string }> = {
      ...exampleDescriptor,
      version: 1,
      steps: [
        {
          name: 'corrupt',
          fromVersion: 0,
          apply: () => ({
            state: { count: 'not-a-number', label: 'x' } as unknown as {
              count: number;
              label: string;
            },
          }),
        },
      ],
    };
    const result = runMigrations(bad, { label: 'x' }, 0);
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') throw new Error('unreachable');
    expect(result.reason).toMatch(/schema validation failed/);
  });

  it('quarantines when a step throws', () => {
    const throwing: MigrationDescriptor<{ count: number; label: string }> = {
      ...exampleDescriptor,
      version: 1,
      steps: [
        {
          name: 'kaboom',
          fromVersion: 0,
          apply: () => {
            throw new Error('oops');
          },
        },
      ],
    };
    const result = runMigrations(throwing, { label: 'x' }, 0);
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') throw new Error('unreachable');
    expect(result.reason).toMatch(/oops/);
  });

  it('quarantines on migration graph gap', () => {
    const gapped: MigrationDescriptor<{ count: number; label: string }> = {
      ...exampleDescriptor,
      version: 3,
      steps: [
        // Step at fromVersion 0 → 1. No step from 1 → 2 → 3.
        {
          name: 'partial',
          fromVersion: 0,
          apply: () => ({ state: { count: 0, label: 'x' } }),
        },
      ],
    };
    const result = runMigrations(gapped, { label: 'x' }, 0);
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') throw new Error('unreachable');
    expect(result.reason).toMatch(/migration graph gap/);
  });

  it('quarantines on a middle gap without running the later step on stale data', () => {
    const ran: number[] = [];
    const gapped: MigrationDescriptor<{ count: number; label: string }> = {
      ...exampleDescriptor,
      schema: undefined,
      version: 4,
      // No 2 → 3 step.
      steps: [trackedStep(ran, 'one-to-two', 1), trackedStep(ran, 'three-to-four', 3)],
    };
    const result = runMigrations(gapped, { count: 1, label: 'x' }, 1);
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') throw new Error('unreachable');
    expect(result.reason).toMatch(/migration graph gap: no step from v2/);
    expect(ran).toEqual([1]);
  });

  it('quarantines on a leading gap (first applicable step is ahead of the data)', () => {
    const ran: number[] = [];
    const gapped: MigrationDescriptor<{ count: number; label: string }> = {
      ...exampleDescriptor,
      schema: undefined,
      version: 3,
      steps: [trackedStep(ran, 'two-to-three', 2)],
    };
    const result = runMigrations(gapped, { count: 1, label: 'x' }, 1);
    expect(result.kind).toBe('quarantined');
    if (result.kind !== 'quarantined') throw new Error('unreachable');
    expect(result.reason).toMatch(/migration graph gap: no step from v1/);
    expect(ran).toEqual([]);
  });

  it('adopts a pre-framework v0 blob as v1 when no v0 step exists, but not past a later gap', () => {
    const ran: number[] = [];
    const fromOne: MigrationDescriptor<{ count: number; label: string }> = {
      ...exampleDescriptor,
      schema: undefined,
      version: 2,
      steps: [trackedStep(ran, 'one-to-two', 1)],
    };
    expect(runMigrations(fromOne, { count: 1, label: 'x' }, 0).kind).toBe('ok');
    expect(ran).toEqual([1]);

    const gapAfterV1: MigrationDescriptor<{ count: number; label: string }> = {
      ...fromOne,
      version: 3,
      steps: [trackedStep(ran, 'two-to-three', 2)],
    };
    expect(runMigrations(gapAfterV1, { count: 1, label: 'x' }, 0).kind).toBe('quarantined');
  });

  it('passes lossy events through', () => {
    const withLossy: MigrationDescriptor<{ count: number; label: string }> = {
      ...exampleDescriptor,
      steps: [
        {
          name: 'truncate-label',
          fromVersion: 0,
          apply: (s) => {
            const v = (s ?? {}) as { label?: string };
            return {
              state: { count: 0, label: (v.label ?? '').slice(0, 3) },
              lossy: [{ field: 'label', reason: 'truncated' }],
            };
          },
        },
      ],
      version: 1,
    };
    const result = runMigrations(withLossy, { label: 'long-label' }, 0);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.lossy).toEqual([{ field: 'label', reason: 'truncated' }]);
    expect(result.state).toEqual({ count: 0, label: 'lon' });
  });
});
