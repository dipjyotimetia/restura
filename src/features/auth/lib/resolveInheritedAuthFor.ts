import type { AuthConfig, Request } from '@/types';
import { useCollectionStore } from '@/store/useCollectionStore';
import {
  findInheritedAuthWithSource,
  isConfiguredAuth,
  type InheritedAuth,
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
 * hook, and the Auth-tab "Inherits…" hint. The collection runner and
 * workflow executor do NOT use this — they thread inherited auth themselves
 * (flattenRunnables / getInheritedAuth) before reaching the protocol layer.
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
