/**
 * The Collection run flatten: walks a collection tree into the ordered list of
 * request leaves a run executes, threading what each leaf inherits from the
 * folders above it.
 *
 *  - scripts: collection -> folder(s) -> request, parent first (`combineScripts`);
 *  - auth: nearest ancestor with a configured auth wins (Postman semantics);
 *  - folder variables: one list per folder, outermost first;
 *  - the Postman send guard: a request the guard refuses carries `blocked`.
 *
 * Both hosts use this walk (the app's `flattenRunnables`, the CLI's
 * `collectionLoader`). They differ only in what they do with a leaf, which are
 * the explicit options below.
 */
import { isConfiguredAuth } from '../auth/inheritance';
import {
  nextPostmanAuthGuard,
  type PostmanAuthGuard,
  postmanBlockedReason,
} from '../collections/postman/auth-guard';
import { combineScripts } from '../scripts/combine-scripts';
import type { AuthConfig, Collection, CollectionItem, ScopedVariable } from '../types';

/** One request leaf with everything it inherits. */
export interface FlattenedLeaf {
  /** The tree item (`item.request` is defined). */
  item: CollectionItem;
  /** Folder names from the collection root to the leaf's parent. */
  folderPath: string[];
  /** Folder variables, outermost first; only folders that declare any. */
  folderVariables: ScopedVariable[][];
  /** Ancestor scripts plus the request's own, combined parent-first. */
  preRequestScript: string | undefined;
  testScript: string | undefined;
  /**
   * Nearest ancestor auth that is configured (else the root auth), even for a
   * blocked leaf; hosts decide what a blocked leaf does with it.
   */
  inheritedAuth: AuthConfig | undefined;
  /** Set when the Postman send guard refuses this leaf: it must not be sent. */
  blocked?: string;
}

/** Collection-scope (root) scripts, applied to every request in the run. */
export interface RootScripts {
  preRequestScript?: string | undefined;
  testScript?: string | undefined;
}

/** What a host does with a request leaf. */
export type LeafAction = 'run' | 'skip';

export interface FlattenOptions {
  /** Collection-level scripts, threaded into every leaf. */
  rootScripts?: RootScripts | undefined;
  /** Collection-level auth, the fallback of the nearest-ancestor rule. */
  rootAuth?: AuthConfig | undefined;
  /** The collection itself, for the Postman guard's root (sidecar + name). */
  root?: Collection | undefined;
  /** Run only this folder's subtree (ancestors' scripts/auth/guard still apply). */
  folderId?: string | undefined;
  /** Who is named in a block reason: `Restura` (app) or `the CLI`. */
  sender: string;
  /**
   * How the guard names the container an inherited block came from: the
   * folder's own name (app) or its slash-joined path (CLI).
   */
  guardOwner: 'name' | 'path';
  /**
   * Decide a request leaf before it is collected (connection presets and other
   * unrunnable kinds are `skip`). Called in tree order; a host may report here.
   */
  leafAction?: ((item: CollectionItem, path: string) => LeafAction) | undefined;
  /** Drop a folder (and its subtree) before descending, e.g. an import placeholder. */
  skipFolder?: ((folder: CollectionItem, path: string) => boolean) | undefined;
  /** Walk a non-folder item that holds `items` but no request (the app does; the CLI drops it). */
  walkUntypedContainers?: boolean | undefined;
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
 * folder, so a folder run still applies the scripts of folders above it.
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

interface Inherited {
  pre: Array<string | undefined>;
  test: Array<string | undefined>;
  auth: AuthConfig | undefined;
  names: string[];
  variables: ScopedVariable[][];
  guard: PostmanAuthGuard;
}

/** Nearest-ancestor-wins: a configured folder auth replaces the inherited one. */
function effectiveFolderAuth(
  item: CollectionItem,
  current: AuthConfig | undefined
): AuthConfig | undefined {
  return isConfiguredAuth(item.auth) ? item.auth : current;
}

/**
 * Flatten a collection (or, with `folderId`, one folder subtree) into its
 * request leaves in preorder. Returns `[]` when `folderId` is not found.
 */
export function flattenCollection(
  items: CollectionItem[],
  options: FlattenOptions
): FlattenedLeaf[] {
  const { rootScripts, rootAuth, root, folderId, sender, guardOwner } = options;
  const rootGuard: PostmanAuthGuard = root
    ? nextPostmanAuthGuard({}, root)
    : isConfiguredAuth(rootAuth)
      ? { configured: { owner: 'collection' } }
      : {};
  const ownerOf = (names: string[], folder: CollectionItem) =>
    guardOwner === 'path' ? names.join('/') : folder.name;

  const descend = (inherited: Inherited, folder: CollectionItem): Inherited => {
    const names = [...inherited.names, folder.name];
    return {
      pre: [...inherited.pre, folder.preRequestScript],
      test: [...inherited.test, folder.testScript],
      auth: effectiveFolderAuth(folder, inherited.auth),
      names,
      variables: folder.variables
        ? [...inherited.variables, folder.variables]
        : inherited.variables,
      guard: nextPostmanAuthGuard(inherited.guard, folder, ownerOf(names, folder)),
    };
  };

  const out: FlattenedLeaf[] = [];
  const walk = (level: CollectionItem[], inherited: Inherited): void => {
    for (const item of level) {
      const path = [...inherited.names, item.name].join('/');
      if (item.type === 'folder') {
        if (options.skipFolder?.(item, path)) continue;
        walk(item.items ?? [], descend(inherited, item));
        continue;
      }
      const req = item.request as { preRequestScript?: string; testScript?: string } | undefined;
      if (!req) {
        // Not a request or a typed folder: the app still walked what it holds.
        if (options.walkUntypedContainers && item.items) walk(item.items, descend(inherited, item));
        continue;
      }
      if ((options.leafAction?.(item, path) ?? 'run') === 'skip') continue;
      const blocked = postmanBlockedReason(item, inherited.guard, sender);
      out.push({
        item,
        folderPath: inherited.names,
        folderVariables: inherited.variables,
        preRequestScript: combineScripts([...inherited.pre, req.preRequestScript]),
        testScript: combineScripts([...inherited.test, req.testScript]),
        inheritedAuth: inherited.auth,
        ...(blocked ? { blocked } : {}),
      });
    }
  };

  const start: Inherited = {
    pre: [rootScripts?.preRequestScript],
    test: [rootScripts?.testScript],
    auth: rootAuth,
    names: [],
    variables: [],
    guard: rootGuard,
  };

  if (!folderId) {
    walk(items, start);
    return out;
  }
  const path = findFolderPath(items, folderId);
  if (!path || path.length === 0) return [];
  const target = path[path.length - 1];
  if (!target?.items) return [];
  const inherited = path.reduce<Inherited>((acc, folder) => descend(acc, folder), start);
  walk(target.items, inherited);
  return out;
}
