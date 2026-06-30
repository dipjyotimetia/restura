/**
 * Helpers for migrating off the legacy zustand/persist `window.localStorage`
 * layout (`{ state, version }`). `migrateLegacyLocalStorage` is called from a
 * store's `migrate` hook (the hand-rolled core stores) to read the legacy state
 * slice and drop the key. The read/parse and remove steps are split into small
 * primitives so the parsing rules live in one place.
 */

/**
 * Safely read and JSON.parse a legacy localStorage entry. Returns the parsed
 * value (typically `{ state, version }`), or null when the key is absent,
 * unreadable, or not valid JSON. Does NOT remove the key — removal timing
 * differs by caller.
 */
export function readLegacyLocalStorageEntry(key: string): unknown {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Remove a legacy localStorage key, swallowing any access error. No-op when the key is absent. */
export function removeLegacyLocalStorageEntry(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * One-shot migration from the legacy zustand/persist localStorage layout into
 * the Dexie-backed adapter. Call from a store's `migrate` hook only when the
 * Dexie read returned the default (empty) state. Returns the legacy state slice
 * or null. Always removes the legacy key after a read attempt so subsequent page
 * loads don't re-migrate (and so stale data doesn't pollute the next version
 * bump).
 */
export function migrateLegacyLocalStorage<T = unknown>(name: string): T | null {
  const parsed = readLegacyLocalStorageEntry(name);
  removeLegacyLocalStorageEntry(name);
  if (parsed && typeof parsed === 'object' && 'state' in parsed) {
    const state = (parsed as { state?: T }).state;
    return state === undefined || state === null ? null : state;
  }
  return null;
}
