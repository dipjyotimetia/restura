import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestRehydrate: vi.fn(),
  environmentRehydrate: vi.fn(),
  settingsRehydrate: vi.fn(),
  collectionRehydrate: vi.fn(),
  historyRehydrate: vi.fn(),
}));

function persistedStore(rehydrate: () => Promise<void>) {
  return Object.assign(vi.fn(), { persist: { rehydrate } });
}

vi.mock('@/store/useRequestStore', () => ({
  useRequestStore: persistedStore(mocks.requestRehydrate),
}));
vi.mock('@/store/useEnvironmentStore', () => ({
  useEnvironmentStore: persistedStore(mocks.environmentRehydrate),
}));
vi.mock('@/store/useSettingsStore', () => ({
  useSettingsStore: persistedStore(mocks.settingsRehydrate),
}));
vi.mock('@/store/useCollectionStore', () => ({
  useCollectionStore: persistedStore(mocks.collectionRehydrate),
}));
vi.mock('@/store/useHistoryStore', () => ({
  useHistoryStore: persistedStore(mocks.historyRehydrate),
}));

import { useStoreHydration } from '../useStoreHydration';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const rehydrateMocks = [
  mocks.requestRehydrate,
  mocks.environmentRehydrate,
  mocks.settingsRehydrate,
  mocks.collectionRehydrate,
  mocks.historyRehydrate,
];

beforeEach(() => {
  for (const rehydrate of rehydrateMocks) {
    rehydrate.mockReset();
  }
});

describe('useStoreHydration', () => {
  it('reports hydration only after every selected store resolves', async () => {
    const hydrations = rehydrateMocks.map(() => deferred());
    rehydrateMocks.forEach((rehydrate, index) => {
      rehydrate.mockReturnValue(hydrations[index]?.promise);
    });

    const { result } = renderHook(() => useStoreHydration());

    expect(result.current).toBe(false);
    expect(rehydrateMocks.every((rehydrate) => rehydrate.mock.calls.length === 1)).toBe(true);

    await act(async () => {
      for (const hydration of hydrations.slice(0, -1)) {
        hydration.resolve();
      }
      await Promise.all(hydrations.slice(0, -1).map(({ promise }) => promise));
    });
    expect(result.current).toBe(false);

    await act(async () => {
      hydrations.at(-1)?.resolve();
      await hydrations.at(-1)?.promise;
    });
    expect(result.current).toBe(true);
  });

  it('ignores a completed hydration batch after its effect is cleaned up', async () => {
    const discardedHydrations = rehydrateMocks.map(() => deferred());
    const activeHydrations = rehydrateMocks.map(() => deferred());
    rehydrateMocks.forEach((rehydrate, index) => {
      rehydrate
        .mockReturnValueOnce(discardedHydrations[index]?.promise)
        .mockReturnValueOnce(activeHydrations[index]?.promise);
    });

    const { result } = renderHook(() => useStoreHydration(), { reactStrictMode: true });
    expect(rehydrateMocks.every((rehydrate) => rehydrate.mock.calls.length === 2)).toBe(true);

    await act(async () => {
      for (const hydration of discardedHydrations) {
        hydration.resolve();
      }
      await Promise.all(discardedHydrations.map(({ promise }) => promise));
    });
    expect(result.current).toBe(false);

    await act(async () => {
      for (const hydration of activeHydrations) {
        hydration.resolve();
      }
      await Promise.all(activeHydrations.map(({ promise }) => promise));
    });
    expect(result.current).toBe(true);
  });
});
