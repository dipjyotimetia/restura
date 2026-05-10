import type { AuthConfig, Collection, CollectionItem, Request } from '@/types';

export function resolveEffectiveAuth(requestAuth: AuthConfig, inheritedAuth?: AuthConfig): AuthConfig {
  if (requestAuth.type && requestAuth.type !== 'none') return requestAuth;
  return inheritedAuth ?? requestAuth;
}

// Folder-level auth override is not implemented; only collection-level auth is propagated.
export function findInheritedAuth(collection: Collection, requestId: string): AuthConfig | undefined {
  const visit = (items: CollectionItem[], current: AuthConfig | undefined): AuthConfig | undefined => {
    for (const item of items) {
      if (item.type === 'request' && item.request?.id === requestId) return current;
      if (item.items) {
        const found = visit(item.items, current);
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
