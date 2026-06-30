/**
 * A no-op zustand persist `migrate` for a store that gains an explicit
 * `version` without any change to its persisted shape.
 *
 * Existing persisted blobs carry zustand's default `version: 0`. Bumping the
 * persist option to `version: 1` WITHOUT a migrate makes zustand log
 * "State loaded from storage couldn't be migrated since no migrate function was
 * provided" on every existing user's next load and then use the data anyway.
 * Supplying this passthrough adopts the persisted state unchanged and silences
 * that error, while establishing the migration seam — so the next real shape
 * change has an explicit hook to extend (bump to v2 + a real step) instead of
 * being forced to introduce versioning first (the change that would otherwise
 * trip the same error).
 */
export function passthroughMigrate<T>(persistedState: unknown): T {
  return persistedState as T;
}
