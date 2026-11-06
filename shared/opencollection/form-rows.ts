import type { RequestBody } from '../types';

/**
 * Converts an OpenCollection `multipartForm` / `formUrlEncoded` block to form rows.
 * Form parts are carried through as written (they round-trip the internal row
 * shape), except `enabled`: like headers/params (`kvToInternal`), a row written
 * without the flag is enabled. The send rule keeps only truthy-`enabled` rows,
 * so leaving it unset would silently drop the row in every harness.
 */
export function formRowsToInternal(form: unknown): NonNullable<RequestBody['formData']> {
  const parts = (form as { parts?: unknown } | null | undefined)?.parts;
  if (!Array.isArray(parts)) return [];
  return parts.map((part) => {
    const row = (part && typeof part === 'object' ? part : {}) as Record<string, unknown>;
    return (row.enabled === undefined ? { ...row, enabled: true } : row) as never;
  });
}
