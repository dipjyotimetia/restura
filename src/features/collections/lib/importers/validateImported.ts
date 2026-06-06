import { collectionSchema } from '@/lib/shared/validations';
import type { Collection } from '@/types';

/**
 * Validation gate for importer output. Every importer (Postman, Insomnia,
 * OpenAPI, Hoppscotch, Bruno, OpenCollection) converts to the canonical
 * `Collection` shape, and converters have bugs — a malformed import that
 * passes straight into the Zustand store corrupts persisted state and only
 * surfaces much later as a broken sidebar or runner.
 *
 * This gate runs the SAME Zod schema the store validators use, but only as a
 * reject-check: on success the ORIGINAL object is kept, never the parsed
 * copy. Zod strips unknown keys on parse, and importer outputs can carry
 * passthrough bags (e.g. OpenCollection's `_oc` for byte-stable round-trips)
 * that must survive untouched.
 */

export type ImportValidation = { ok: true } | { ok: false; issues: string[] };

const MAX_ISSUES = 10;

export function validateImportedCollection(collection: Collection): ImportValidation {
  const result = collectionSchema.safeParse(collection);
  if (result.success) return { ok: true };
  const issues = result.error.issues
    .slice(0, MAX_ISSUES)
    .map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`);
  const more = result.error.issues.length - issues.length;
  if (more > 0) issues.push(`… and ${more} more issue${more === 1 ? '' : 's'}`);
  return { ok: false, issues };
}
