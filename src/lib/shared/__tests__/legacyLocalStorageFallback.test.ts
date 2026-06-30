import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { withLegacyLocalStorageFallback } from '../legacyLocalStorageFallback';

/** In-memory PersistStorage stand-in for the Dexie adapter. */
function memoryStorage<T>(): PersistStorage<T> & { map: Map<string, StorageValue<T>> } {
  const map = new Map<string, StorageValue<T>>();
  return {
    map,
    getItem: async (name) => map.get(name) ?? null,
    setItem: async (name, value) => {
      map.set(name, value);
    },
    removeItem: async (name) => {
      map.delete(name);
    },
  };
}

interface DemoState {
  count: number;
}

const STORE_NAME = 'demo-storage';
const LEGACY_KEY = 'demo-storage';

describe('withLegacyLocalStorageFallback', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('serves the inner value, and purges a legacy key left over from a crashed migration', async () => {
    const inner = memoryStorage<DemoState>();
    const live: StorageValue<DemoState> = { state: { count: 5 }, version: 0 };
    inner.map.set(STORE_NAME, live);
    // Simulates a prior session that wrote Dexie but crashed before purging the
    // plaintext copy.
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ state: { count: 99 }, version: 0 }));

    const wrapped = withLegacyLocalStorageFallback(inner, LEGACY_KEY);
    const got = await wrapped.getItem(STORE_NAME);

    // The Dexie value wins (never the stale plaintext)...
    expect(got).toEqual(live);
    // ...and the lingering plaintext copy is cleaned up so it can't outlive the migration.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('does not throw when the inner store has data and there is no legacy key', async () => {
    const inner = memoryStorage<DemoState>();
    const live: StorageValue<DemoState> = { state: { count: 5 }, version: 0 };
    inner.map.set(STORE_NAME, live);

    const wrapped = withLegacyLocalStorageFallback(inner, LEGACY_KEY);
    expect(await wrapped.getItem(STORE_NAME)).toEqual(live);
  });

  it('imports the legacy value into the inner store and purges the plaintext copy', async () => {
    const inner = memoryStorage<DemoState>();
    const legacy: StorageValue<DemoState> = { state: { count: 42 }, version: 0 };
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));

    const wrapped = withLegacyLocalStorageFallback(inner, LEGACY_KEY);
    const got = await wrapped.getItem(STORE_NAME);

    expect(got).toEqual(legacy);
    // Written into the encrypted store...
    expect(inner.map.get(STORE_NAME)).toEqual(legacy);
    // ...and the plaintext copy removed so it can't be re-imported or leak.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('returns null and clears a malformed legacy blob so it cannot wedge the import', async () => {
    const inner = memoryStorage<DemoState>();
    localStorage.setItem(LEGACY_KEY, '{not valid json');

    const wrapped = withLegacyLocalStorageFallback(inner, LEGACY_KEY);
    const got = await wrapped.getItem(STORE_NAME);

    expect(got).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(inner.map.size).toBe(0);
  });

  it('returns null when neither inner nor legacy has data', async () => {
    const inner = memoryStorage<DemoState>();
    const wrapped = withLegacyLocalStorageFallback(inner, LEGACY_KEY);
    expect(await wrapped.getItem(STORE_NAME)).toBeNull();
  });

  it('keeps the legacy key when the inner write fails so a later load can retry', async () => {
    const inner = memoryStorage<DemoState>();
    const legacy: StorageValue<DemoState> = { state: { count: 7 }, version: 0 };
    localStorage.setItem(LEGACY_KEY, JSON.stringify(legacy));
    inner.setItem = vi.fn(async () => {
      throw new Error('dexie write failed');
    });

    const wrapped = withLegacyLocalStorageFallback(inner, LEGACY_KEY);
    const got = await wrapped.getItem(STORE_NAME);

    expect(got).toEqual(legacy);
    // Not purged — the data only lives in localStorage until a write succeeds.
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  it('delegates setItem and removeItem to the inner adapter', async () => {
    const inner = memoryStorage<DemoState>();
    const wrapped = withLegacyLocalStorageFallback(inner, LEGACY_KEY);

    await wrapped.setItem(STORE_NAME, { state: { count: 1 }, version: 0 });
    expect(inner.map.get(STORE_NAME)).toEqual({ state: { count: 1 }, version: 0 });

    await wrapped.removeItem(STORE_NAME);
    expect(inner.map.has(STORE_NAME)).toBe(false);
  });
});
