/**
 * One-line `k=v, k2=v2` preview of a case's variables, values ellipsized.
 * Shared by the dataset editor's collapsed rows and the report matrix's case
 * labels so the preview format can't drift between them.
 */
export function summarizeVars(
  vars: Record<string, string>,
  maxPairs: number,
  maxValueLen: number
): string {
  return Object.entries(vars)
    .slice(0, maxPairs)
    .map(([k, v]) => `${k}=${v.length > maxValueLen ? `${v.slice(0, maxValueLen)}…` : v}`)
    .join(', ');
}
