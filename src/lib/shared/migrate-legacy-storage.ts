/**
 * One-shot migration from the legacy zustand/persist localStorage layout
 * (`{ state, version }`) into the Dexie-backed adapter.
 *
 * Call from a store's `migrate` hook only when the Dexie read returned
 * the default (empty) state. Returns the legacy state slice or null.
 *
 * Always removes the legacy key after a read attempt so subsequent page
 * loads don't re-migrate (and so stale data doesn't pollute the next
 * version bump).
 */
export function migrateLegacyLocalStorage<T = unknown>(name: string): T | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(name);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: T };
    try {
      window.localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
    if (parsed.state === undefined || parsed.state === null) return null;
    return parsed.state;
  } catch {
    try {
      window.localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
    return null;
  }
}
