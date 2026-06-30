/**
 * Subscribes the migration telemetry (Gap #6) to the app logger so store
 * migrations that quarantine or drop fields are observable. The framework emits
 * a `MigrationOutcome` for every adopted store's rehydrate; without a subscriber
 * those events go into the void. Call once at startup (see `main.tsx`), before
 * the stores finish their async rehydrate.
 *
 * Also surfaces any state quarantined by a PRIOR session's failed migration, so
 * a one-off corruption that reset a store to defaults isn't silently forgotten.
 */

import { listQuarantined } from './quarantine';
import { migrationTelemetry } from './telemetry';
import { createLogger, type Logger } from '@/lib/shared/logger';

let unsubscribe: (() => void) | null = null;

/**
 * Wire migration outcomes to the logger. Idempotent — a second call replaces the
 * prior subscription. `log` is injectable for tests. Returns the unsubscribe fn.
 */
export function registerMigrationLogging(log: Logger = createLogger('persistence')): () => void {
  unsubscribe?.();
  unsubscribe = migrationTelemetry.on((outcome) => {
    if (outcome.kind === 'quarantined') {
      log.error('store migration quarantined; reset to defaults (raw state recoverable)', {
        store: outcome.store,
        from: outcome.from,
        reason: outcome.reason,
        quarantineKey: outcome.quarantineKey,
      });
    } else if (outcome.kind === 'ok' && outcome.lossy.length > 0) {
      log.warn('store migration applied with lossy fields', {
        store: outcome.store,
        from: outcome.from,
        to: outcome.to,
        applied: outcome.applied,
        lossy: outcome.lossy,
      });
    }
  });

  // Best-effort: report quarantine records left from a previous session.
  void listQuarantined()
    .then((entries) => {
      if (entries.length > 0) {
        log.warn('quarantined persisted state present from a prior failed migration', {
          count: entries.length,
        });
      }
    })
    .catch(() => {
      /* best-effort — never block startup on diagnostics */
    });

  return unsubscribe;
}
