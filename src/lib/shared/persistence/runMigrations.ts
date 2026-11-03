/**
 * Pure migration runner (Gap #6). Apply each step in order, then validate
 * against the descriptor's optional schema. No IDB / Dexie / storage I/O —
 * trivially unit-testable under `@vitest-environment node`.
 *
 * Outcomes:
 *   - `noop`         — no persisted state (first run); zustand falls back to initial.
 *   - `ok`           — every step applied; schema (if present) validated.
 *   - `quarantined`  — schema invalid OR a step threw. Caller writes raw to metadata.
 */

import type { LossyEvent, MigrationDescriptor, MigrationOutcome } from './types';

export function runMigrations<T>(
  descriptor: MigrationDescriptor<T>,
  persistedState: unknown,
  fromVersion: number | null
): MigrationOutcome {
  // First run / empty persistence — let zustand use the store's initialState.
  if (persistedState === undefined || persistedState === null) {
    return { kind: 'noop', store: descriptor.store, at: descriptor.version };
  }

  let current: unknown = persistedState;
  let version = fromVersion ?? 0;
  // v0 is the pre-framework blob, adopted unchanged as v1 when a descriptor
  // declares no v0 step (the v0 → v1 bump was a pure passthrough; see
  // storeVersioning.test.ts). Every other missing step is a real gap.
  if (version === 0 && !descriptor.steps.some((s) => s.fromVersion === 0)) version = 1;
  const applied: string[] = [];
  const lossy: LossyEvent[] = [];

  const stepsToRun = descriptor.steps
    .filter((s) => s.fromVersion >= version && s.fromVersion < descriptor.version)
    .sort((a, b) => a.fromVersion - b.fromVersion);

  for (const step of stepsToRun) {
    // A leading or middle gap means this step was written for a different
    // shape than the data now holds; running it would report `ok` on a state
    // that skipped a migration. Quarantine before touching the data.
    if (step.fromVersion !== version) {
      return {
        kind: 'quarantined',
        store: descriptor.store,
        from: fromVersion,
        reason: `migration graph gap: no step from v${version} (next step '${step.name}' starts at v${step.fromVersion})`,
        quarantineKey: makeQuarantineKey(descriptor),
      };
    }
    try {
      const out = step.apply(current);
      current = out.state;
      if (out.lossy?.length) lossy.push(...out.lossy);
      applied.push(step.name);
      version = step.fromVersion + 1;
    } catch (err) {
      return {
        kind: 'quarantined',
        store: descriptor.store,
        from: fromVersion,
        reason: `step '${step.name}' threw: ${(err as Error).message}`,
        quarantineKey: makeQuarantineKey(descriptor),
      };
    }
  }

  // If we ran any steps but didn't reach the target version, the migration
  // graph has a gap (e.g. step at v3 with no v2 step from v1). Quarantine so
  // a missing step never silently writes a partial state.
  if (applied.length > 0 && version !== descriptor.version) {
    return {
      kind: 'quarantined',
      store: descriptor.store,
      from: fromVersion,
      reason: `migration graph gap: reached v${version}, expected v${descriptor.version}`,
      quarantineKey: makeQuarantineKey(descriptor),
    };
  }

  const validated = validatePersistedState(descriptor, current, fromVersion);
  if (validated.kind === 'quarantined') return validated;
  current = validated.state;

  return {
    kind: 'ok',
    store: descriptor.store,
    from: fromVersion ?? 0,
    to: descriptor.version,
    applied,
    lossy,
    state: current,
  };
}

/**
 * Validate a (migrated or same-version) persisted state against the
 * descriptor's schema. Returns the parsed state, or the quarantine outcome to
 * record. With no schema the state passes through unchanged.
 */
export function validatePersistedState<T>(
  descriptor: MigrationDescriptor<T>,
  state: unknown,
  fromVersion: number | null
): { kind: 'valid'; state: unknown } | Extract<MigrationOutcome, { kind: 'quarantined' }> {
  if (!descriptor.schema) return { kind: 'valid', state };
  const result = descriptor.schema.safeParse(state);
  if (result.success) return { kind: 'valid', state: result.data };
  return {
    kind: 'quarantined',
    store: descriptor.store,
    from: fromVersion,
    reason: `schema validation failed: ${result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}=${i.message}`)
      .join('; ')}`,
    quarantineKey: makeQuarantineKey(descriptor),
  };
}

function makeQuarantineKey<T>(d: MigrationDescriptor<T>): string {
  return `quarantine:${d.store}:${d.persistName}:${new Date().toISOString()}`;
}
