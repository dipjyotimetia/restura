import type { AuthConfig, Collection, CollectionItem, Request } from '@/types';

/**
 * The inheritance predicate: an auth block participates in folder/collection
 * inheritance only when it's actually configured — `type: 'none'` (or absent)
 * never masks an ancestor's auth. Every place that walks the tree (runner
 * threading in `flattenRunnables`, `findInheritedAuth`, the Postman importer)
 * consumes this so Postman's nearest-ancestor-wins semantics stay in one spot.
 */
export function isConfiguredAuth(auth: AuthConfig | undefined): auth is AuthConfig {
  return auth !== undefined && auth.type !== 'none';
}

export function resolveEffectiveAuth(
  requestAuth: AuthConfig,
  inheritedAuth?: AuthConfig
): AuthConfig {
  if (requestAuth.type && requestAuth.type !== 'none') return requestAuth;
  return inheritedAuth ?? requestAuth;
}

/**
 * Resolve the auth a request inherits when its own auth is 'none': the
 * nearest ancestor folder's auth, falling back to the collection-level auth
 * (Postman folder-auth semantics).
 *
 * Note: the collection runner does NOT call this — `flattenRunnables` threads
 * the same rule in its single tree pass. This per-request lookup is the entry
 * point for single-send inheritance (not wired yet).
 */
export function findInheritedAuth(
  collection: Collection,
  requestId: string
): AuthConfig | undefined {
  const visit = (
    items: CollectionItem[],
    current: AuthConfig | undefined
  ): AuthConfig | undefined => {
    for (const item of items) {
      if (item.type === 'request' && item.request?.id === requestId) return current;
      if (item.items) {
        const next = isConfiguredAuth(item.auth) ? item.auth : current;
        const found = visit(item.items, next);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(collection.items, collection.auth);
}

export function withEffectiveAuth<T extends Request>(request: T, inheritedAuth?: AuthConfig): T {
  return {
    ...request,
    auth: resolveEffectiveAuth(request.auth, inheritedAuth),
  };
}
