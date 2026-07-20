/**
 * Walk a collection's nested CollectionItem tree.
 *
 * The workflow UI (sidebar palette, inspectors, request-node renderers)
 * all need to look up or enumerate saved requests by id. Pre-extraction
 * each had its own recursive `findRequestInItems` / `traverse` walk;
 * `find` / `walk` here are the shared implementation.
 */
import type { CollectionItem, HttpRequest, Request } from '@/types';

/** Find a single request by id. Returns `undefined` if missing. */
export function findRequestInItems(
  items: CollectionItem[],
  requestId: string
): Request | undefined {
  for (const item of items) {
    if (item.type === 'request' && item.request?.id === requestId) {
      return item.request;
    }
    if (item.items) {
      const found = findRequestInItems(item.items, requestId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Resolve an OWS saved-request binding. OpenCollection does not persist the
 * renderer's UUIDs, so a Git workspace binds to the deterministic logical
 * percent-encoded folder/request path. Renderer UUIDs are deliberately not a
 * fallback: OpenCollection regenerates them on load, so accepting one would
 * make a Git-native workflow silently non-portable.
 */
export function findRequestByReference(
  items: CollectionItem[],
  reference: string,
  parentPath = ''
): Request | undefined {
  for (const item of items) {
    const segment = encodeURIComponent(item.name);
    const logicalPath = parentPath ? `${parentPath}/${segment}` : segment;
    if (item.type === 'request' && item.request && logicalPath === reference) {
      return item.request;
    }
    if (item.items) {
      const found = findRequestByReference(item.items, reference, logicalPath);
      if (found) return found;
    }
  }
  return undefined;
}

export interface RequestSummary {
  /** The underlying request's id (stable across renames). */
  id: string;
  /** Display name from the CollectionItem (mirrors the sidebar tree). */
  name: string;
  /** HTTP method, or the uppercased `request.type` for non-HTTP protocols. */
  method: string;
  /** Underlying request `type` discriminator — `'http' | 'grpc' | 'sse' | 'mcp' | ...`. */
  kind: Request['type'];
  /** Slash-joined breadcrumb of folder names. */
  path: string;
}

/** Flatten the tree into a list of request summaries, with folder paths. */
export function flattenRequests(items: CollectionItem[]): RequestSummary[] {
  const out: RequestSummary[] = [];
  const walk = (curr: CollectionItem[], path: string) => {
    for (const item of curr) {
      if (item.type === 'request' && item.request) {
        const r = item.request;
        out.push({
          id: r.id,
          name: item.name,
          method: r.type === 'http' ? (r as HttpRequest).method : r.type.toUpperCase(),
          kind: r.type,
          path: path ? `${path} / ${item.name}` : item.name,
        });
      }
      if (item.items) walk(item.items, path ? `${path} / ${item.name}` : item.name);
    }
  };
  walk(items, '');
  return out;
}
