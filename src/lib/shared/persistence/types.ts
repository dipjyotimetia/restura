/**
 * State-migration framework types (Gap #6). Single source of truth for the
 * shape of every Zustand store's persistence and migration graph.
 *
 * Each store registers a `MigrationDescriptor` in `registry.ts`; the
 * `createPersistedStore` factory builds the corresponding zustand `persist`
 * options. Migration failures quarantine the raw bytes into `metadata` so
 * pre-1.0 data is recoverable rather than silently dropped.
 */

import type { ZodType } from 'zod';

/** All persisted Zustand store names. */
export type StoreName =
  | 'collections'
  | 'environments'
  | 'history'
  | 'settings'
  | 'cookies'
  | 'workflows'
  | 'workflowExecutions'
  | 'fileCollections'
  | 'requestTabs'
  | 'websocketConnections'
  | 'sseConnections'
  | 'mcpConnections'
  | 'kafkaConnections'
  | 'socketioConnections'
  | 'console'
  | 'graphqlSchemas'
  | 'protoFiles';

/** A single field that a migration dropped or coerced. */
export interface LossyEvent {
  /** Dotted path into the persisted state, e.g. "schemas['url1'].errors". */
  field: string;
  reason: 'dropped' | 'coerced' | 'truncated';
  detail?: string;
}

/**
 * One migration step. Each step advances `fromVersion` → `fromVersion + 1`.
 * Steps are pure functions over the persisted state — keep them
 * deterministic and side-effect free (apart from logging).
 */
export interface MigrationStep<T = unknown> {
  /** Stable identifier for telemetry / diffing. e.g. 'legacy-localstorage-import'. */
  name: string;
  /** State.version BEFORE this step. Step takes vN, produces vN+1. */
  fromVersion: number;
  apply: (state: unknown) => { state: T; lossy?: LossyEvent[] };
}

/**
 * Per-store persistence + migration descriptor.
 */
export interface MigrationDescriptor<T = unknown> {
  store: StoreName;
  /** zustand persist `name` (the persist key inside Dexie's table). */
  persistName: string;
  /** Current target version. Bump when adding a new MigrationStep. */
  version: number;
  steps: MigrationStep[];
  /** Optional Zod schema run after the final step; failure → quarantine. */
  schema?: ZodType<T>;
  /** Optional partialize. Same semantics as zustand persist.partialize. */
  partialize?: (state: T) => Partial<T>;
}

export type MigrationOutcome =
  | {
      kind: 'ok';
      store: StoreName;
      from: number;
      to: number;
      applied: string[];
      lossy: LossyEvent[];
      state: unknown;
    }
  | { kind: 'noop'; store: StoreName; at: number }
  | {
      kind: 'quarantined';
      store: StoreName;
      from: number | null;
      reason: string;
      /** key under which the raw persisted state was stashed in metadata. */
      quarantineKey: string;
    };
