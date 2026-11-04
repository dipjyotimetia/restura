/**
 * Persist a script's `pm.environment.set/unset` writes to an environment, as
 * Postman does: a set updates the variable (or adds it), an unset removes it.
 *
 * A variable held as a desktop secret handle (`secretRef`) is never touched: a
 * script write would replace the keychain-backed value with renderer
 * plaintext, and an unset would orphan the keychain entry. Those keys are
 * returned as `skipped` so the caller can say so.
 *
 * Trust: a script from a collection can only write, without asking, to an
 * environment scoped to that same collection. A write to a shared (global)
 * environment could redirect another collection's requests — and the secrets
 * they carry — so it is held and the user asked once per collection and
 * environment (see {@link saveScriptEnvironmentWrites}).
 */
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { Environment } from '@/types';

export interface EnvironmentMutationOutcome {
  environment: Environment;
  /** Keys left alone because the variable is a secret handle. */
  skipped: string[];
  changed: boolean;
}

export function applyEnvironmentMutations(
  environment: Environment,
  mutations: Readonly<Record<string, string | null>>,
  createId: () => string = uuidv4
): EnvironmentMutationOutcome {
  let variables = environment.variables;
  const skipped: string[] = [];
  let changed = false;
  for (const [key, value] of Object.entries(mutations)) {
    const existing = variables.filter((variable) => variable.key === key);
    if (existing.some((variable) => variable.secretRef !== undefined)) {
      skipped.push(key);
      continue;
    }
    if (value === null) {
      if (existing.length === 0) continue;
      variables = variables.filter((variable) => variable.key !== key);
      changed = true;
    } else if (existing.length === 0) {
      variables = [...variables, { id: createId(), key, value, enabled: true }];
      changed = true;
    } else if (existing.some((variable) => variable.value !== value || !variable.enabled)) {
      variables = variables.map((variable) =>
        variable.key === key ? { ...variable, value, enabled: true } : variable
      );
      changed = true;
    }
  }
  return {
    environment: changed ? { ...environment, variables } : environment,
    skipped,
    changed,
  };
}

/** Merge the environment writes of several script phases, a later phase winning. */
export function mergeEnvironmentMutations(
  ...phases: ReadonlyArray<
    { success: boolean; environmentMutations?: Record<string, string | null> } | undefined
  >
): Record<string, string | null> | undefined {
  const merged: Record<string, string | null> = {};
  for (const phase of phases) {
    if (phase?.environmentMutations) Object.assign(merged, phase.environmentMutations);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The environment a single send's script writes go to: the active one, when it
 * applies to the request (a collection-scoped environment applies only to its
 * own collection's requests). Undefined when no environment is in scope.
 * Capture it when the request is sent: the user may switch environment while
 * it is in flight, and the writes belong to the one the request ran against.
 */
export function scriptEnvironmentTargetId(collectionId: string | undefined): string | undefined {
  const active = useEnvironmentStore.getState().getActiveEnvironment();
  if (!active) return undefined;
  if (active.collectionId !== undefined && active.collectionId !== collectionId) return undefined;
  return active.id;
}

/** Tell the user which script writes were not applied because the variable is a secret handle. */
export function warnSkippedSecretWrites(skipped: readonly string[]): void {
  if (skipped.length === 0) return;
  toast.warning(
    `Script did not change secret environment variable${skipped.length > 1 ? 's' : ''}: ${skipped.join(', ')}`
  );
}

/** Apply `mutations` to the stored environment `environmentId`. Returns the skipped keys. */
export function persistScriptEnvironmentMutations(
  environmentId: string | undefined,
  mutations: Readonly<Record<string, string | null>> | undefined
): string[] {
  if (!environmentId || !mutations || Object.keys(mutations).length === 0) return [];
  const store = useEnvironmentStore.getState();
  const environment = store.environments.find((candidate) => candidate.id === environmentId);
  if (!environment) return [];
  const outcome = applyEnvironmentMutations(environment, mutations);
  if (outcome.changed) {
    store.updateEnvironment(environmentId, { variables: outcome.environment.variables });
  }
  return outcome.skipped;
}

/** Collection/environment pairs the user allowed to write this session. */
const approvedSharedWrites = new Set<string>();
/** Writes awaiting the user's answer, keyed like {@link approvedSharedWrites}. */
const pendingSharedWrites = new Map<string, Record<string, string | null>>();

/** Test hook: forget approvals and pending writes. */
export function resetScriptEnvironmentApprovals(): void {
  approvedSharedWrites.clear();
  pendingSharedWrites.clear();
}

/**
 * Save a script's `pm.environment` writes to `environmentId` (captured when the
 * request was sent), applying the trust rule above:
 * - an environment scoped to the script's collection, or a request that is not
 *   in any collection (a script the user wrote in the tab), saves directly;
 * - a shared environment written by a collection's script waits for the user,
 *   once per collection and environment; until then (or if declined) the
 *   writes last only for the request or run they were made in.
 */
export function saveScriptEnvironmentWrites(input: {
  environmentId: string | undefined;
  collectionId: string | undefined;
  mutations: Readonly<Record<string, string | null>> | undefined;
}): void {
  const { environmentId, collectionId, mutations } = input;
  if (!environmentId || !mutations || Object.keys(mutations).length === 0) return;
  const environment = useEnvironmentStore
    .getState()
    .environments.find((candidate) => candidate.id === environmentId);
  if (!environment) return;
  const pairKey = `${collectionId ?? ''}\u0000${environmentId}`;
  const trusted =
    collectionId === undefined ||
    environment.collectionId === collectionId ||
    approvedSharedWrites.has(pairKey);
  if (trusted) {
    warnSkippedSecretWrites(persistScriptEnvironmentMutations(environmentId, mutations));
    return;
  }

  const pending = { ...pendingSharedWrites.get(pairKey), ...mutations };
  pendingSharedWrites.set(pairKey, pending);
  const keys = Object.keys(pending);
  toast.warning(
    `A collection script wants to change the shared environment "${environment.name}"`,
    {
      id: `script-env-write:${pairKey}`,
      description: `Variables: ${keys.join(', ')}. Not saved yet — they apply to this run only.`,
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: 'Save',
        onClick: () => {
          approvedSharedWrites.add(pairKey);
          const approved = pendingSharedWrites.get(pairKey);
          pendingSharedWrites.delete(pairKey);
          warnSkippedSecretWrites(persistScriptEnvironmentMutations(environmentId, approved));
        },
      },
      cancel: {
        label: "Don't save",
        onClick: () => {
          pendingSharedWrites.delete(pairKey);
        },
      },
    }
  );
}
