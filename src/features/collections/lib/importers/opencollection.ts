import type { Collection } from '@/types';
import { openCollectionSchema, ocToInternal } from '@/lib/opencollection';

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
  const result = openCollectionSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid OpenCollection document: ${issues}`);
  }
  // ocToInternal augments the returned Collection with a non-typed `_oc` bag
  // that the exporter uses for byte-stable round-trip. Cast so callers receive
  // the standard Collection type.
  return ocToInternal(result.data) as Collection;
}
