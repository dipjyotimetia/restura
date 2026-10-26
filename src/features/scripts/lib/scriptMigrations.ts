/**
 * Moved to `shared/scripts/script-migrations.ts` (runtime-neutral, so the
 * shared Postman parser and the CLI can use it). Re-exported for existing
 * renderer callers.
 */
export { migrateScriptPmToRs, migrateScriptRsToPm } from '@shared/scripts/script-migrations';
