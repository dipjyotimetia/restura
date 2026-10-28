import { postmanBlockedReasonFor } from '@shared/collections/postman/auth-guard';
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
 * hook, the Auth-tab "Inherits…" hint, and the OWS saved-request dispatcher.
 * The collection runner does NOT use this — `flattenRunnables` threads the
 * same rule in its single tree pass.
 */
export function resolveInheritedAuthFor(
  request: Pick<Request, 'id'> & { auth: AuthConfig }
): InheritedAuth | undefined {
  if (isConfiguredAuth(request.auth)) return undefined;
  for (const collection of useCollectionStore.getState().collections) {
    // Never hand out a credential the Postman send guard refuses (explicit
    // `noauth` / unsupported Postman auth, #1232): every caller then sends
    // without it, and `executeRequest` refuses the send outright.
    if (postmanBlockedReasonFor(collection, request.id, 'Restura', request.auth)) return undefined;
    const found = findInheritedAuthWithSource(collection, request.id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Why this request must not be sent (Postman send guard, #1232), or
 * `undefined` — also for requests outside every collection. `request.auth`
 * is the live (tab) auth: a configured one is always sendable.
 */
export function postmanSendBlockedReason(
  request: Pick<Request, 'id'> & { auth: AuthConfig }
): string | undefined {
  for (const collection of useCollectionStore.getState().collections) {
    const reason = postmanBlockedReasonFor(collection, request.id, 'Restura', request.auth);
    if (reason) return reason;
  }
  return undefined;
}

/** A send refused by the Postman send guard (#1232); `message` is the user-facing reason. */
export class PostmanAuthBlockedError extends Error {
  override name = 'PostmanAuthBlockedError';
}

/** Throw {@link PostmanAuthBlockedError} when the Postman send guard refuses this request. */
export function assertPostmanSendable(request: Pick<Request, 'id'> & { auth: AuthConfig }): void {
  const reason = postmanSendBlockedReason(request);
  if (reason) throw new PostmanAuthBlockedError(reason);
}

/**
 * Send-time {@link resolveInheritedAuthFor}: refuses (throws
 * {@link PostmanAuthBlockedError}) instead of sending a request the Postman
 * send guard blocks, matching the CLI and `executeRequest` (#1232).
 */
export function resolveInheritedAuthForSend(
  request: Pick<Request, 'id'> & { auth: AuthConfig }
): InheritedAuth | undefined {
  assertPostmanSendable(request);
  return resolveInheritedAuthFor(request);
}
