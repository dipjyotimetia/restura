/** Escape regex metacharacters so a user-supplied value can be embedded literally. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
