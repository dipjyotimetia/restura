import { importPostmanCollection as importPostmanShared } from '@shared/collections/postman';
import { migrateScriptPmToRs } from '@/features/scripts/lib/scriptMigrations';
import type { Collection, PostmanCollection } from '@/types';
import type { ImportWarning } from './types';

/**
 * Renderer adapter over the runtime-neutral Postman parser in
 * `shared/collections/postman/` (ADR 0034). Kept async and with its original
 * signature so existing callers (ImportDialog, tests) are unchanged.
 *
 * Report entries are forwarded into `warnings`; constructs Restura cannot
 * model are kept in the `_postman` sidecar on the relevant node.
 */
export async function importPostmanCollection(
  postmanData: PostmanCollection | unknown,
  warnings?: ImportWarning[]
): Promise<Collection> {
  const { collection, report } = importPostmanShared(postmanData, {
    // Auto-migrate Postman's `pm.*` namespace to Restura's native `rs.*`.
    transformScript: migrateScriptPmToRs,
  });
  if (warnings) {
    const forwarded: ImportWarning[] = report.warnings;
    warnings.push(...forwarded);
  }
  return collection;
}
