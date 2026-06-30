// `fake-indexeddb/auto` backs the real `db` used by quarantineState. The
// dexie-storage ADAPTER (the inner persist storage) is separately mocked to a
// noop by tests/setup.ts, so the legacy-localStorage fallback is exercised via
// real window.localStorage.
import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { db } from '@/lib/shared/database';
import { createPersistedStore } from '../createPersistedStore';
import type { MigrationStep } from '../types';

interface DemoState {
  value: number;
}

describe('createPersistedStore', () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.metadata.clear();
  });

  afterAll(async () => {
    await db.delete();
  });

  it('maps descriptor fields onto PersistOptions', () => {
    const opts = createPersistedStore<DemoState>({
      store: 'globals',
      persistName: 'demo',
      version: 3,
      steps: [],
    });
    expect(opts.name).toBe('demo');
    expect(opts.version).toBe(3);
    expect(typeof opts.migrate).toBe('function');
    expect(opts.storage).toBeDefined();
  });

  it('migrate returns persisted state unchanged when there are no steps', async () => {
    const opts = createPersistedStore<DemoState>({
      store: 'globals',
      persistName: 'demo',
      version: 1,
      steps: [],
    });
    const persisted = { value: 7 };
    await expect(opts.migrate?.(persisted, 0)).resolves.toEqual(persisted);
  });

  it('migrate applies a versioned step', async () => {
    const bump: MigrationStep = {
      name: 'v0->v1 double',
      fromVersion: 0,
      apply: (s) => ({ state: { value: (s as DemoState).value * 2 } }),
    };
    const opts = createPersistedStore<DemoState>({
      store: 'globals',
      persistName: 'demo',
      version: 1,
      steps: [bump],
    });
    await expect(opts.migrate?.({ value: 5 }, 0)).resolves.toEqual({ value: 10 });
  });

  it('migrate quarantines (returns undefined + writes to metadata) when the schema rejects', async () => {
    const opts = createPersistedStore<DemoState>({
      store: 'globals',
      persistName: 'demo',
      version: 1,
      steps: [],
      schema: z.object({ value: z.number() }),
    });
    await expect(opts.migrate?.({ value: 'not-a-number' }, 0)).resolves.toBeUndefined();
    const quarantined = await db.metadata.filter((m) => m.key.startsWith('quarantine:')).toArray();
    expect(quarantined.length).toBeGreaterThan(0);
  });

  it('onRehydrate runs on the happy path with the state', () => {
    const onRehydrate = vi.fn();
    const opts = createPersistedStore<DemoState>({
      store: 'globals',
      persistName: 'demo',
      version: 1,
      steps: [],
      onRehydrate,
    });
    const post = (
      opts.onRehydrateStorage as (() => (s: unknown, e: unknown) => void) | undefined
    )?.();
    const state = { value: 1 };
    post?.(state, undefined);
    expect(onRehydrate).toHaveBeenCalledWith(state, undefined);
  });

  it('on a rehydrate error, logs the error AND still runs onRehydrate (after the log)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const onRehydrate = vi.fn();
      const opts = createPersistedStore<DemoState>({
        store: 'globals',
        persistName: 'demo',
        version: 1,
        steps: [],
        onRehydrate,
      });
      const post = (
        opts.onRehydrateStorage as (() => (s: unknown, e: unknown) => void) | undefined
      )?.();
      const err = new Error('rehydrate boom');
      post?.(undefined, err);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(onRehydrate).toHaveBeenCalledWith(undefined, err);
      // Ordering: the factory logs the error before invoking the descriptor hook.
      expect(errorSpy.mock.invocationCallOrder[0]!).toBeLessThan(
        onRehydrate.mock.invocationCallOrder[0]!
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
