/** Shared helpers for OpenCollection file handling across the extension. */

/** Narrow an unknown to a plain object (not null, not an array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Root collection filenames, `.yml` preferred (mirrors fs-reader's ROOT_FILES). */
export const ROOT_FILENAMES = ['opencollection.yml', 'opencollection.yaml'] as const;

/** True for `opencollection.yml` / `opencollection.yaml` (case-insensitive). */
export function isRootFilename(basename: string): boolean {
  return (ROOT_FILENAMES as readonly string[]).includes(basename.toLowerCase());
}
