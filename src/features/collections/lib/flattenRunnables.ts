import { isConfiguredAuth } from '@/features/auth/lib/authInheritance';
import type { AuthConfig, CollectionItem, Request } from '@/types';

/**
 * A single executable leaf extracted from a collection tree, preserving the
 * tree's preorder so the runner sends requests top-to-bottom exactly as the
 * user sees them in the sidebar.
 *
 * `request.preRequestScript` / `request.testScript` carry the EFFECTIVE scripts
 * for this run: collection-level and folder-level scripts are combined with the
 * request's own, in Postman's parent-to-child order (collection -> folder(s) ->
 * request), so the runner can execute them in a single pass without knowing the
 * tree shape.
 *
 * `inheritedAuth` is the auth a request with `auth.type === 'none'` should
 * fall back to: the nearest ancestor folder's auth, else the collection-level
 * auth (Postman folder-auth semantics). The runner applies it via
 * `withEffectiveAuth`.
 */
export interface RunnableRequest {
  itemId: string;
  name: string;
  request: Request;
  inheritedAuth?: AuthConfig;
}

/** Collection-scope (root) scripts, applied to every request in the run. */
export interface RootScripts {
  preRequestScript?: string;
  testScript?: string;
}

/** Nearest-ancestor-wins: a configured folder auth replaces the inherited one. */
function effectiveFolderAuth(
  item: CollectionItem,
  current: AuthConfig | undefined
): AuthConfig | undefined {
  return isConfiguredAuth(item.auth) ? item.auth : current;
}

/** Join non-empty script fragments in order; undefined when nothing applies. */
function combineScripts(parts: Array<string | undefined>): string | undefined {
  const nonEmpty = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return nonEmpty.length > 0 ? nonEmpty.join('\n') : undefined;
}

/** Bake the inherited (ancestor) scripts plus the request's own into a copy. */
function withEffectiveScripts(
  request: Request,
  inheritedPre: Array<string | undefined>,
  inheritedTest: Array<string | undefined>
): Request {
  const preRequestScript = combineScripts([...inheritedPre, request.preRequestScript]);
  const testScript = combineScripts([...inheritedTest, request.testScript]);
  return { ...request, preRequestScript, testScript } as Request;
}

/** Depth-first preorder flatten of request leaves, threading ancestor scripts + auth. */
function flatten(
  items: CollectionItem[],
  inheritedPre: Array<string | undefined>,
  inheritedTest: Array<string | undefined>,
  inheritedAuth: AuthConfig | undefined
): RunnableRequest[] {
  const out: RunnableRequest[] = [];
  for (const item of items) {
    if (item.type === 'request' && item.request) {
      out.push({
        itemId: item.id,
        name: item.name,
        request: withEffectiveScripts(item.request, inheritedPre, inheritedTest),
        inheritedAuth,
      });
    } else if (item.items) {
      out.push(
        ...flatten(
          item.items,
          [...inheritedPre, item.preRequestScript],
          [...inheritedTest, item.testScript],
          effectiveFolderAuth(item, inheritedAuth)
        )
      );
    }
  }
  return out;
}

/** Find a folder anywhere in the tree by id. */
export function findFolder(items: CollectionItem[], folderId: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === folderId && item.type === 'folder') return item;
    if (item.items) {
      const found = findFolder(item.items, folderId);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Path of folders from the outermost ancestor down to and including the target
 * folder. Used so a folder run still applies the scripts of folders above it.
 */
export function findFolderPath(
  items: CollectionItem[],
  folderId: string
): CollectionItem[] | undefined {
  for (const item of items) {
    if (item.id === folderId && item.type === 'folder') return [item];
    if (item.items) {
      const sub = findFolderPath(item.items, folderId);
      if (sub) return [item, ...sub];
    }
  }
  return undefined;
}

/**
 * Flatten a collection (or, when `folderId` is given, a single folder subtree)
 * into an ordered list of runnable requests, each carrying its effective
 * combined scripts and inherited auth (nearest folder auth, else `rootAuth` —
 * the collection-level auth). Returns `[]` when the folder isn't found.
 */
export function flattenRunnables(
  items: CollectionItem[],
  folderId?: string,
  rootScripts?: RootScripts,
  rootAuth?: AuthConfig
): RunnableRequest[] {
  const rootPre: Array<string | undefined> = [rootScripts?.preRequestScript];
  const rootTest: Array<string | undefined> = [rootScripts?.testScript];

  if (!folderId) return flatten(items, rootPre, rootTest, rootAuth);

  const path = findFolderPath(items, folderId);
  if (!path || path.length === 0) return [];
  const target = path[path.length - 1];
  if (!target?.items) return [];

  // A folder run still inherits auth from folders above the target, so walk
  // the path applying the same nearest-ancestor-wins rule.
  const pathAuth = path.reduce<AuthConfig | undefined>(
    (current, folder) => effectiveFolderAuth(folder, current),
    rootAuth
  );

  return flatten(
    target.items,
    [...rootPre, ...path.map((f) => f.preRequestScript)],
    [...rootTest, ...path.map((f) => f.testScript)],
    pathAuth
  );
}
