/**
 * Storage-layer one-shot import from the legacy zustand/localStorage layout
 * (`{ state, version }`) into a `PersistStorage` adapter.
 *
 * Some stores shipped without a `storage` adapter, so zustand persisted them to
 * plaintext `window.localStorage` — an ADR-0014 violation ("the legacy
 * localStorage adapter has been removed"), and on desktop their contents
 * (endpoint URLs, proto file bodies) sat unencrypted at rest. Pointing such a
 * store at the encrypted Dexie adapter must not strand the data already in
 * localStorage.
 *
 * A zustand `migrate` hook can't do this: zustand only invokes `migrate` when
 * the *new* storage already returns a row (its hydrate path skips migrate
 * entirely when `getItem` resolves to null), which is never true on the
 * empty-Dexie first load that is exactly the localStorage→Dexie transition. So
 * the import happens at the storage layer instead.
 *
 * Kept dependency-light (zustand types only, no Dexie/database imports) so it is
 * directly unit-testable and free of the IndexedDB mock the storage adapters
 * carry.
 */

import type { PersistStorage, StorageValue } from 'zustand/middleware';

export function withLegacyLocalStorageFallback<T>(
  inner: PersistStorage<T>,
  legacyKey: string
): PersistStorage<T> {
  return {
    ...inner,
    getItem: async (name: string): Promise<StorageValue<T> | null> => {
      const current = await inner.getItem(name);
      if (current !== null) return current;
      if (typeof window === 'undefined') return null;

      let raw: string | null;
      try {
        raw = window.localStorage.getItem(legacyKey);
      } catch {
        return null;
      }
      if (!raw) return null;

      let parsed: StorageValue<T> | null = null;
      try {
        const candidate = JSON.parse(raw) as unknown;
        if (candidate && typeof candidate === 'object' && 'state' in candidate) {
          parsed = candidate as StorageValue<T>;
        }
      } catch {
        parsed = null;
      }

      // Always drop the legacy key after an attempt: a malformed blob must not
      // wedge the import path on every reload.
      if (parsed === null) {
        try {
          window.localStorage.removeItem(legacyKey);
        } catch {
          /* ignore */
        }
        return null;
      }

      // Persist into the (encrypted Dexie) store before removing the plaintext
      // copy, so a crash mid-migration can neither lose the data nor leave it
      // unencrypted. If the write fails, keep the legacy key so a later load
      // retries rather than silently dropping the data.
      try {
        await inner.setItem(name, parsed);
      } catch {
        return parsed;
      }
      try {
        window.localStorage.removeItem(legacyKey);
      } catch {
        /* ignore */
      }
      return parsed;
    },
  };
}
