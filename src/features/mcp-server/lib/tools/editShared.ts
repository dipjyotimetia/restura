/**
 * Helpers shared by the edit-tier tool modules (collections, environments):
 * approval fingerprints, consent grants on creation, and undo with a
 * staleness check.
 */

import { canEditEnvironment, type McpServerConsent } from '@shared/mcp-server/consent';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { Environment } from '@/types';
import { updateMcpConsent } from '../settings';
import { refuse, SETTINGS_HINT, type ToolEnv } from './types';

/** Binds an approval to the exact collection / environment state the user saw. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Give the agent edit access to something it just created — and nothing else —
 * so it can keep working in it. Undoing the create removes the thing itself;
 * a dangling override for a deleted id grants nothing.
 */
export function grant(update: (consent: McpServerConsent) => McpServerConsent): void {
  updateMcpConsent(update);
}

/**
 * Thrown when an undo would also discard changes made after the agent's
 * change. Undo entries can still be applied in reverse order.
 */
export class UndoConflictError extends Error {
  constructor(what: string) {
    super(
      `${what} changed after this agent change, so undoing it would also discard the later changes. Undo the later changes first.`
    );
    this.name = 'UndoConflictError';
  }
}

export const currentEnvironment = (id: string) =>
  useEnvironmentStore.getState().environments.find((e) => e.id === id);

export function editableEnvironment(environmentId: string, env: ToolEnv) {
  const environment = useEnvironmentStore
    .getState()
    .environments.find((e) => e.id === environmentId);
  if (!environment || !canEditEnvironment(env.settings.consent, environment.id)) {
    return refuse(
      `Environment not found or not shared for editing: ${environmentId}. ${SETTINGS_HINT}`
    );
  }
  return environment;
}

/** Same contract as {@link restoreCollection}, for environments. */
export function restoreEnvironment(
  before: Environment | undefined,
  id: string = before?.id ?? ''
): () => void {
  const after = fingerprint(currentEnvironment(id));
  return () => {
    if (fingerprint(currentEnvironment(id)) !== after) {
      throw new UndoConflictError(
        `Environment “${before?.name ?? currentEnvironment(id)?.name ?? id}”`
      );
    }
    const store = useEnvironmentStore.getState();
    if (!before) store.removeEnvironment(id);
    else if (currentEnvironment(id)) store.updateEnvironment(id, before);
    else store.addEnvironment(before);
  };
}
