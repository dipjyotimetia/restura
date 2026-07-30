/**
 * Store-aware bridge over the pure `buildValueMap`: gathers the variable scopes
 * that apply to the ACTIVE tab's request — active environment, workspace globals,
 * and the collection the request belongs to (resolved from the tab's
 * `savedRequestId`) — and merges them with the standard precedence
 * (globals < env < collection). Shared by every single-send path so validation
 * (`useVariableStatus`) and execution stay in lockstep. Pre-request-script
 * mutations are layered on top by the caller at send time.
 */

import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { CollectionItem, ScopedVariable } from '@/types';
import type { SecretValue } from '@/lib/shared/secretRef';
import { buildValueMap } from './variableScopes';

export function findAncestorFolderVariables(
  items: CollectionItem[],
  requestId: string,
  ancestors: ScopedVariable[][] = []
): ScopedVariable[][] | undefined {
  for (const item of items) {
    if (item.id === requestId) return ancestors;
    if (item.type === 'folder') {
      const found = findAncestorFolderVariables(
        item.items ?? [],
        requestId,
        item.variables ? [...ancestors, item.variables] : ancestors
      );
      if (found) return found;
    }
  }
  return undefined;
}

export function buildActiveRequestValueMap(): Record<string, string> {
  return buildActiveRequestVariableResolution().values;
}

/** Values safe for the renderer plus opaque desktop-only SecretRef handles. */
export function buildActiveRequestVariableResolution(): {
  values: Record<string, string>;
  secretVariables: Record<string, SecretValue>;
} {
  const savedRequestId = useRequestStore.getState().getActiveTab()?.savedRequestId;
  const collectionRecord = savedRequestId
    ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)?.variables
    : undefined;
  const collectionOwner = savedRequestId
    ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)
    : undefined;
  const environmentChain = useEnvironmentStore
    .getState()
    .getActiveEnvironmentChain()
    .filter(
      (environment) =>
        environment.collectionId === undefined || environment.collectionId === collectionOwner?.id
    );
  const [baseEnvironment, subEnvironment] = environmentChain;
  const globals = useGlobalsStore.getState().vars;
  const folders =
    savedRequestId && collectionOwner
      ? findAncestorFolderVariables(collectionOwner.items, savedRequestId)
      : undefined;
  const values = buildValueMap({
    globals,
    baseEnvironment: baseEnvironment?.variables,
    subEnvironment: subEnvironment?.variables,
    collection: collectionRecord,
    folders,
  });
  const secretVariables: Record<string, SecretValue> = {};
  const scopes = [
    baseEnvironment?.variables,
    subEnvironment?.variables,
    collectionRecord,
    ...(folders ?? []),
  ];
  for (const scope of scopes) {
    for (const variable of scope ?? []) {
      if (!variable.enabled || !variable.key) continue;
      if (variable.secretRef !== undefined) {
        delete values[variable.key];
        secretVariables[variable.key] = variable.secretRef;
      } else {
        delete secretVariables[variable.key];
      }
    }
  }
  return { values, secretVariables };
}
