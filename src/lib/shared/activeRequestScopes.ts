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
  const environmentChain = useEnvironmentStore.getState().getActiveEnvironmentChain();
  const [baseEnvironment, subEnvironment] = environmentChain;
  const globals = useGlobalsStore.getState().vars;
  const savedRequestId = useRequestStore.getState().getActiveTab()?.savedRequestId;
  const collection = savedRequestId
    ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)?.variables
    : undefined;
  const collectionRecord = savedRequestId
    ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)
    : undefined;
  const folders =
    savedRequestId && collectionRecord
      ? findAncestorFolderVariables(collectionRecord.items, savedRequestId)
      : undefined;
  return buildValueMap({
    globals,
    baseEnvironment: baseEnvironment?.variables,
    subEnvironment: subEnvironment?.variables,
    collection,
    folders,
  });
}
