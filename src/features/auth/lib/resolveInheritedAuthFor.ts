import { useCollectionStore } from '@/store/useCollectionStore';
import type { AuthConfig, Request } from '@/types';
import {
  findInheritedAuthWithSource,
  type InheritedAuth,
  isConfiguredAuth,
} from './authInheritance';

/**
 * Resolve the folder/collection auth a request inherits at SEND time, by
 * locating the saved request (matched on `request.id` — preserved when a
 * collection item opens into a tab, see `createTabFromRequest`) across all
 * collections in the store.
 *
 * Returns undefined when the request carries its own configured auth (it
 * always wins), or when no collection contains it (history items, scratch
 * tabs), or when no ancestor has a configured auth.
 *
 * Callers: the registry runner (gRPC/GraphQL single sends), the HTTP send
 * hook, the Auth-tab "Inherits…" hint, and `useWorkflowExecution` (which
 * wraps it as the executors' `getInheritedAuth` callback). The collection
 * runner does NOT use this — `flattenRunnables` threads the same rule in its
 * single tree pass.
 */
export function resolveInheritedAuthFor(
  request: Pick<Request, 'id'> & { auth: AuthConfig }
): InheritedAuth | undefined {
  if (isConfiguredAuth(request.auth)) return undefined;
  for (const collection of useCollectionStore.getState().collections) {
    const found = findInheritedAuthWithSource(collection, request.id);
    if (found) return found;
  }
  return undefined;
}
