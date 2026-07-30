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
import type { CollectionItem, Request } from '@/types';
import { buildValueMap } from './variableScopes';

function findRequest(items: CollectionItem[], itemId: string): Request | undefined {
  for (const item of items) {
    if (item.id === itemId) return item.type === 'request' ? item.request : undefined;
    if (item.items) {
      const found = findRequest(item.items, itemId);
      if (found) return found;
    }
  }
  return undefined;
}

export function buildActiveRequestValueMap(): Record<string, string> {
  const env = useEnvironmentStore.getState().getActiveEnvironment()?.variables;
  const globals = useGlobalsStore.getState().vars;
  const activeTab = useRequestStore.getState().getActiveTab();
  const savedRequestId = activeTab?.savedRequestId;
  const collection = savedRequestId
    ? useCollectionStore.getState().getCollectionByItemId(savedRequestId)?.variables
    : undefined;
  const savedRequestVariables = savedRequestId
    ? findRequest(useCollectionStore.getState().getCollectionByItemId(savedRequestId)?.items ?? [], savedRequestId)
        ?.variables
    : undefined;
  // Prefer the tab copy so edits take effect before Save; fall back to the
  // collection record for callers that only provide a savedRequestId.
  const request = activeTab?.request.variables ?? savedRequestVariables;
  return buildValueMap({ env, globals, collection, request });
}
