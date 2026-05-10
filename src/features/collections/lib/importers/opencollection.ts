import type { Collection } from '@/types';
import {
  openCollectionSchema,
  ocToInternal,
  getAndResetUnrecognizedBodyCount,
} from '@/lib/opencollection';

export interface OpenCollectionImportResult {
  collection: Collection;
  /** Number of HTTP request bodies that didn't match any known shape and
   * were imported as `type: 'none'`. The original body is still preserved
   * in the `_oc` passthrough bag and will round-trip on export. */
  unrecognizedBodies: number;
}

/**
 * Import an OpenCollection v1.0.0 document (already parsed from YAML or JSON)
 * and convert it into a Restura internal Collection.
 *
 * Accepts the bundled-file form (single document with all items inline).
 * Directory-layout import is provided through the Electron file picker via
 * `loadCollectionFromDir` — this entry point handles the in-memory case used
 * by the renderer's drop-zone uploader.
 */
export function importOpenCollection(data: unknown): Collection {
  return importOpenCollectionDetailed(data).collection;
}

/**
 * Like {@link importOpenCollection}, but also returns the count of
 * unrecognized HTTP bodies dropped during import. UI surfaces use this
 * to alert the user that imported requests have content the editor can't
 * surface (data is still preserved via `_oc` for export round-trip).
 */
export function importOpenCollectionDetailed(data: unknown): OpenCollectionImportResult {
  const result = openCollectionSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid OpenCollection document: ${issues}`);
  }
  const collection = ocToInternal(result.data) as Collection;
  return { collection, unrecognizedBodies: getAndResetUnrecognizedBodyCount() };
}
