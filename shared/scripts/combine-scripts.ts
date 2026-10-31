/**
 * Join the collection → folder → request scripts of one phase into the single
 * script the sandbox evaluates. Shared by the app's runner
 * (`flattenRunnables.ts`) and the CLI loader so both build the same text.
 *
 * Postman runs each level in its own scope, so collections routinely declare
 * the same `const` / `let` at two levels. Each part goes in its own block when
 * there are several: `let` / `const` / `class` stay local to their level (no
 * "redeclaration" SyntaxError), while `var`, function declarations (sloppy
 * mode, Annex B) and implicit globals are still shared as before. A single
 * part is returned as-is, keeping its line numbers in error messages.
 */
export function combineScripts(parts: ReadonlyArray<string | undefined>): string | undefined {
  const nonEmpty = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  if (nonEmpty.length === 0) return undefined;
  if (nonEmpty.length === 1) return nonEmpty[0];
  return nonEmpty.map((p) => `{\n${p}\n}`).join('\n');
}
