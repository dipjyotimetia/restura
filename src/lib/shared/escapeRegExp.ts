/**
 * Escape regex metacharacters in a string so it can be embedded literally in a
 * `new RegExp(...)` pattern.
 *
 * Variable substitution builds `{{key}}` patterns from user-supplied environment
 * variable keys. An unescaped key containing metacharacters (`(`, `[`, `*`, …)
 * makes the `RegExp` constructor throw `SyntaxError`, which would crash the send.
 * Always run a dynamic key through this before interpolating it into a pattern.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
