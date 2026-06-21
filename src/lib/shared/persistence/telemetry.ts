/**
 * Tiny typed event emitter for migration outcomes (Gap #6). The console store
 * (or any future Diagnostics panel) can subscribe to render quarantined /
 * lossy events. No third-party dep — Set + iterate.
 */

import type { MigrationOutcome } from './types';

type MigrationListener = (outcome: MigrationOutcome) => void;

const listeners = new Set<MigrationListener>();

export const migrationTelemetry = {
  on(cb: MigrationListener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  emit(outcome: MigrationOutcome): void {
    for (const cb of listeners) {
      try {
        cb(outcome);
      } catch {
        /* never let a listener crash the rest */
      }
    }
  },
};
