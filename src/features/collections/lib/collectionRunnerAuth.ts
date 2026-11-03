import { withEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { AuthConfig, CollectionItem, Request } from '@/types';

/**
 * True when the request itself owns an OAuth2 auth — the only case a refreshed
 * token may be written back onto it. An inherited (folder / collection) auth is
 * never materialised onto the request. Same guard as `useRequestRunner`.
 */
export function ownsOAuth2Auth(request: Request): boolean {
  return request.type === 'http' && request.auth?.type === 'oauth2';
}

function findItemByRequestId(
  items: readonly CollectionItem[],
  requestId: string
): CollectionItem | undefined {
  for (const item of items) {
    if (item.type === 'request' && item.request?.id === requestId) return item;
    if (item.items) {
      const found = findItemByRequestId(item.items, requestId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Write a refreshed OAuth2 auth onto the saved request in the collection store.
 * Reads the STORED request (a runnable carries combined run scripts) and skips
 * when the saved request no longer owns an OAuth2 auth.
 */
function persistRefreshedRequestAuth(collectionId: string, requestId: string, auth: AuthConfig) {
  const store = useCollectionStore.getState();
  const collection = store.collections.find((candidate) => candidate.id === collectionId);
  const item = collection ? findItemByRequestId(collection.items, requestId) : undefined;
  const stored = item?.request;
  if (!item || stored?.type !== 'http' || stored.auth?.type !== 'oauth2') return;
  store.updateCollectionItem(collectionId, item.id, { request: { ...stored, auth } });
}

/**
 * OAuth2 refresh bookkeeping for one batch run (collection runner, OWS
 * workflow). Requests are resolved once per run, so without this a token
 * refreshed on one send is lost to the next: with a rotating refresh token the
 * second iteration fails with `invalid_grant`.
 */
export interface RunAuthSession {
  /** The request with its effective auth, carrying any token refreshed earlier in the run. */
  authed<T extends Request>(request: T, inheritedAuth: AuthConfig | undefined): T;
  /** The `RunContext.onAuthRefreshed` sink for one send of `request`. */
  onRefreshed(request: Request, inheritedAuth: AuthConfig | undefined): (auth: AuthConfig) => void;
}

export function createRunAuthSession(collectionId: string): RunAuthSession {
  // Keyed by request id (owned auth) and by the inherited auth object (shared
  // by every request under the same folder / collection).
  const owned = new Map<string, AuthConfig>();
  const inherited = new Map<AuthConfig, AuthConfig>();
  return {
    authed(request, inheritedAuth) {
      const own = ownsOAuth2Auth(request) ? owned.get(request.id) : undefined;
      const base = own ? { ...request, auth: own } : request;
      const parent = inheritedAuth ? (inherited.get(inheritedAuth) ?? inheritedAuth) : undefined;
      return withEffectiveAuth(base, parent);
    },
    onRefreshed(request, inheritedAuth) {
      return (auth) => {
        if (ownsOAuth2Auth(request)) {
          owned.set(request.id, auth);
          persistRefreshedRequestAuth(collectionId, request.id, auth);
        } else if (inheritedAuth) {
          // In-run only: never written onto the request or back to its folder.
          inherited.set(inheritedAuth, auth);
        }
      };
    },
  };
}
