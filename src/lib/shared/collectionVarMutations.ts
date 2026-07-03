/**
 * Apply a `pm.collectionVariables.set/unset` mutation batch onto a plain
 * `Record<string,string>` in place — `null` removes the key, a string
 * sets/creates it. Shared by the renderer's collection runner (which also
 * persists the same mutations to `useCollectionStore`) and the CLI runner
 * (which keeps the map in memory for the run only, matching Postman/Newman's
 * transient collection-variable semantics).
 */
export function applyVarMutations(
  target: Record<string, string>,
  mutations: Record<string, string | null> | undefined
): void {
  if (!mutations) return;
  for (const [key, value] of Object.entries(mutations)) {
    if (value === null) delete target[key];
    else target[key] = value;
  }
}
