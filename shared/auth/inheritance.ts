import type { AuthConfig, Collection, CollectionItem, Request } from '../types';

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

/** Inherited auth plus where it came from — `sourceName` feeds UI hints. */
export interface InheritedAuth {
  auth: AuthConfig;
  /** Name of the folder (or collection) providing the auth. */
  sourceName: string;
}

/**
 * Resolve the auth a request inherits when its own auth is 'none' — the
 * nearest ancestor folder's auth, falling back to the collection-level auth
 * (Postman folder-auth semantics) — along with the providing node's name.
 *
 * Returns undefined when the request isn't in this collection OR when no
 * ancestor has a configured auth (an unconfigured chain inherits nothing).
 *
 * Note: the collection runner does NOT call this — `flattenRunnables` threads
 * the same rule in its single tree pass. This per-request lookup serves
 * single sends (see `resolveInheritedAuthFor`).
 */
export function findInheritedAuthWithSource(
  collection: Collection,
  requestId: string
): InheritedAuth | undefined {
  const root: InheritedAuth | undefined = isConfiguredAuth(collection.auth)
    ? { auth: collection.auth, sourceName: collection.name }
    : undefined;
  const visit = (
    items: CollectionItem[],
    current: InheritedAuth | undefined
  ): InheritedAuth | undefined => {
    for (const item of items) {
      if (item.type === 'request' && item.request?.id === requestId) return current;
      if (item.items) {
        const next = isConfiguredAuth(item.auth)
          ? { auth: item.auth, sourceName: item.name }
          : current;
        const found = visit(item.items, next);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(collection.items, root);
}

/** Auth-only variant of `findInheritedAuthWithSource` (legacy shape). */
export function findInheritedAuth(
  collection: Collection,
  requestId: string
): AuthConfig | undefined {
  return findInheritedAuthWithSource(collection, requestId)?.auth;
}

export function withEffectiveAuth<T extends Request>(request: T, inheritedAuth?: AuthConfig): T {
  return {
    ...request,
    auth: resolveEffectiveAuth(request.auth, inheritedAuth),
  };
}
