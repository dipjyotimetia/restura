/**
 * Persist a script's `pm.environment.set/unset` writes to an environment, as
 * Postman does: a set updates the variable (or adds it), an unset removes it.
 *
 * A variable held as a desktop secret handle (`secretRef`) is never touched: a
 * script write would replace the keychain-backed value with renderer
 * plaintext, and an unset would orphan the keychain entry. Those keys are
 * returned as `skipped` so the caller can say so.
 */
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
 */
export function scriptEnvironmentTargetId(collectionId: string | undefined): string | undefined {
  const active = useEnvironmentStore.getState().getActiveEnvironment();
  if (!active) return undefined;
  if (active.collectionId !== undefined && active.collectionId !== collectionId) return undefined;
  return active.id;
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
