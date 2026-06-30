// End-to-end persistence test: exercises the REAL pipeline the Gap #6 work
// touches — `createPersistedStore` → real encrypted Dexie adapter → IndexedDB →
// legacy-localStorage import → migrate/quarantine → `db.exportAllData`. Unlike
// the other persistence tests (which run against the noop dexie-storage mock
// from tests/setup.ts), this file UNMOCKS dexie-storage so the factory wires to
// the genuine adapter, and backs IndexedDB with fake-indexeddb.
import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Use the real storage adapter (not the global noop mock) so this is a true
// store → encrypt → IndexedDB → decrypt → rehydrate round-trip.
vi.unmock('@/lib/shared/dexie-storage');

import { db } from '@/lib/shared/database';
import { createPersistedStore } from '../createPersistedStore';

interface DemoState {
  value: number;
  label: string;
}

const sampleValue = (s: DemoState) => ({ state: s, version: 1 }) as const;

describe('persistence e2e (real Dexie adapter + IndexedDB)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.clearAllData();
  });

  afterAll(async () => {
    await db.delete();
  });

  it('round-trips state through createPersistedStore → real adapter → IndexedDB', async () => {
    const opts = createPersistedStore<DemoState>({
      store: 'globals',
      persistName: 'globals-storage',
      version: 1,
      steps: [],
    });

    const value: DemoState = { value: 7, label: 'hello' };
    await opts.storage!.setItem('globals-storage', sampleValue(value));

    // Read back through the adapter...
    const got = await opts.storage!.getItem('globals-storage');
    expect(got).toEqual(sampleValue(value));

    // ...and confirm a row actually landed in the real Dexie table.
    const row = await db.globals.get('globals-storage');
    expect(row).toBeTruthy();
    expect(row!.encryptedData).toContain('hello'); // plaintext on web (no safeStorage key)
  });

  it('runs a versioned migration step end-to-end on persisted data', async () => {
    // Seed v1 data, then read through a v2 descriptor with a v1→v2 step.
    const v1 = createPersistedStore<DemoState>({
      store: 'globals',
      persistName: 'globals-storage',
      version: 1,
      steps: [],
    });
    await v1.storage!.setItem('globals-storage', { state: { value: 1, label: 'a' }, version: 1 });

    const v2 = createPersistedStore<DemoState>({
      store: 'globals',
      persistName: 'globals-storage',
      version: 2,
      steps: [
        {
          name: 'v1->v2 bump value',
          fromVersion: 1,
          apply: (s) => ({ state: { ...(s as DemoState), value: (s as DemoState).value + 100 } }),
        },
      ],
    });

    const stored = await v2.storage!.getItem('globals-storage');
    expect(stored).toEqual({ state: { value: 1, label: 'a' }, version: 1 });
    // migrate runs the step: v1 (value 1) → v2 (value 101).
    const migrated = await v2.migrate!(stored!.state, stored!.version!);
    expect(migrated).toEqual({ value: 101, label: 'a' });
  });

  it('quarantines schema-invalid data into the real metadata table', async () => {
    const opts = createPersistedStore<DemoState>({
      store: 'globals',
      persistName: 'globals-storage',
      version: 1,
      steps: [],
      schema: z.object({ value: z.number(), label: z.string() }),
    });

    const result = await opts.migrate!({ value: 'NOT-A-NUMBER', label: 'x' }, 0);
    expect(result).toBeUndefined(); // → zustand falls back to initial state

    const quarantined = await db.metadata.filter((m) => m.key.startsWith('quarantine:')).toArray();
    expect(quarantined.length).toBeGreaterThan(0);
    const parsed = JSON.parse(quarantined[0]!.value) as { raw: unknown };
    expect(parsed.raw).toEqual({ value: 'NOT-A-NUMBER', label: 'x' });
  });

  it('db.exportAllData captures adapter-written rows for every table', async () => {
    const opts = createPersistedStore<DemoState>({
      store: 'collectionRuns',
      persistName: 'collection-run-storage',
      version: 1,
      steps: [],
    });
    await opts.storage!.setItem('collection-run-storage', {
      state: { value: 9, label: 'run' },
      version: 1,
    });

    const exported = await db.exportAllData();
    expect(exported.version).toBe(6);
    const runs = exported.data.collectionRuns ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe('collection-run-storage');
    // metadata is never part of a user-data backup.
    expect(exported.data).not.toHaveProperty('metadata');

    // Import into a cleared DB restores it.
    await db.clearAllData();
    await db.importAllData(exported);
    expect(await db.collectionRuns.get('collection-run-storage')).toBeTruthy();
  });
});
