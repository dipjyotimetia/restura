import { isConfiguredAuth } from '../../auth/inheritance';
import type { AuthConfig, Collection, CollectionItem } from '../../types';
import { getPostmanSidecar } from './sidecar';

/**
 * THE Postman send guard (#1228, #1232), shared by every send path: the CLI
 * loader, the app's single send (`executeRequest`) and its collection runner
 * (`flattenRunnables`).
 *
 * Restura's `{ type: 'none' }` means *inherit*, so two imported Postman
 * shapes would otherwise pick up a credential at send time that Postman
 * itself would never send:
 *  - an explicit Postman `noauth` (marked `_postman.noauth`) on the request,
 *    or on the nearest auth-bearing container, below a configured auth;
 *  - an unsupported Postman auth (hawk, jwt, edgegrid, …) on the request or
 *    on its nearest auth-bearing container, imported as `none`.
 * Such a request is refused (never sent), with a reason naming the source.
 * A `noauth` request with no configured auth above it is sendable: there is
 * nothing to leak.
 */

/**
 * THE predicate for "this node's Postman auth could not be imported"
 * (#1202; also used by the CLI runner and the #1201 exporter — keep the name
 * and signature stable).
 *
 * `node` is an imported collection, folder or request item (or any object
 * with `auth` / `request.auth` and a `_postman` sidecar). Returns the Postman
 * auth type (e.g. `"hawk"`) when the node carries a `_postman.auth` sidecar
 * that is NOT bag-only (bag-only = broker presets / placeholders, whose auth
 * never had a typed model) and its own auth is not configured — i.e. the
 * unsupported type was imported as `none`. Approximated types (OAuth2
 * implicit, OAuth1 RSA, …) also keep a sidecar but map to a configured auth,
 * so they return `undefined`. Never returns credential values.
 */
export function hasUnsupportedPostmanAuth(node: object): string | undefined {
  const sidecar = getPostmanSidecar(node);
  if (!sidecar?.auth || sidecar.authBagOnly) return undefined;
  const n = node as { auth?: AuthConfig; request?: { auth?: AuthConfig } };
  const own = n.request && typeof n.request === 'object' ? n.request.auth : n.auth;
  if (isConfiguredAuth(own)) return undefined;
  const type =
    sidecar.auth && typeof sidecar.auth === 'object'
      ? (sidecar.auth as { type?: unknown }).type
      : undefined;
  return typeof type === 'string' && type !== '' ? type : 'unknown';
}

/** What a container hands its children while walking the tree. */
export interface PostmanAuthGuard {
  /** The nearest auth-bearing container is an unsupported Postman auth. */
  unsupported?: { type: string; owner: string };
  /** The nearest auth-bearing container is an explicit Postman `noauth`. */
  noauth?: { owner: string };
  /** The nearest container with a configured auth (what Restura would substitute). */
  configured?: { owner: string };
}

function hasNoauthMarker(node: object): boolean {
  return getPostmanSidecar(node)?.noauth === true;
}

/** The guard a container (collection / folder) hands its children. */
export function nextPostmanAuthGuard(
  guard: PostmanAuthGuard,
  node: Collection | CollectionItem,
  name: string = node.name
): PostmanAuthGuard {
  const configured = guard.configured ? { configured: guard.configured } : {};
  const type = hasUnsupportedPostmanAuth(node);
  if (type) return { unsupported: { type, owner: name }, ...configured };
  if (isConfiguredAuth((node as { auth?: AuthConfig }).auth))
    return { configured: { owner: name } };
  if (hasNoauthMarker(node)) return { noauth: { owner: name }, ...configured };
  return guard;
}

/** Why a request must not be sent, as a machine-readable cause. */
export type PostmanAuthBlock =
  | { kind: 'unsupported'; type: string; owner?: string }
  | { kind: 'noauth'; source: string; owner?: string };

/**
 * Why `item` must not be sent, or `undefined`. `ownAuth` overrides the
 * item's stored auth (a tab's live auth at send time).
 */
export function postmanAuthBlock(
  item: CollectionItem,
  guard: PostmanAuthGuard,
  ownAuth: AuthConfig | undefined = (item.request as { auth?: AuthConfig } | undefined)?.auth
): PostmanAuthBlock | undefined {
  if (isConfiguredAuth(ownAuth)) return undefined;
  const own = hasUnsupportedPostmanAuth(item);
  if (own) return { kind: 'unsupported', type: own };
  // Fail-safe: any request without its own configured auth below an
  // unsupported container is refused (an explicit `noauth` one included).
  if (guard.unsupported) {
    return { kind: 'unsupported', type: guard.unsupported.type, owner: guard.unsupported.owner };
  }
  if (!guard.configured) return undefined;
  if (hasNoauthMarker(item)) return { kind: 'noauth', source: guard.configured.owner };
  if (guard.noauth) {
    return { kind: 'noauth', source: guard.configured.owner, owner: guard.noauth.owner };
  }
  return undefined;
}

/** The user-facing reason for a block; `sender` names who refuses ("the CLI", "Restura"). */
export function describePostmanAuthBlock(block: PostmanAuthBlock, sender: string): string {
  const from = block.owner ? ` (inherited from "${block.owner}")` : '';
  if (block.kind === 'unsupported') {
    return (
      `not sent: Postman auth type "${block.type}"${from} is not supported by Restura (imported as no auth); ` +
      `${sender} will not send it unauthenticated. Configure a supported auth or exclude the request.`
    );
  }
  return (
    `not sent: Postman auth is "No Auth"${from}, but Restura would substitute the auth of "${block.source}"; ` +
    `${sender} will not send a credential Postman would not send. Configure this request's auth or exclude the request.`
  );
}

/** {@link postmanAuthBlock} + {@link describePostmanAuthBlock}. */
export function postmanBlockedReason(
  item: CollectionItem,
  guard: PostmanAuthGuard,
  sender: string,
  ownAuth?: AuthConfig
): string | undefined {
  const block =
    ownAuth === undefined ? postmanAuthBlock(item, guard) : postmanAuthBlock(item, guard, ownAuth);
  return block ? describePostmanAuthBlock(block, sender) : undefined;
}

/**
 * Tree-walk form for single sends: the reason the request whose
 * `request.id` is `requestId` must not be sent from `collection`, or
 * `undefined` (also when the request is not in the collection).
 */
export function postmanBlockedReasonFor(
  collection: Collection,
  requestId: string,
  sender: string,
  ownAuth?: AuthConfig
): string | undefined {
  const visit = (items: CollectionItem[], guard: PostmanAuthGuard): string | null => {
    for (const item of items) {
      if (item.type === 'request' && item.request?.id === requestId) {
        return postmanBlockedReason(item, guard, sender, ownAuth) ?? '';
      }
      if (item.items) {
        const found = visit(item.items, nextPostmanAuthGuard(guard, item));
        if (found !== null) return found;
      }
    }
    return null;
  };
  const reason = visit(collection.items ?? [], nextPostmanAuthGuard({}, collection));
  return reason ? reason : undefined;
}
