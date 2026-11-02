import {
  findFolderPath as findFolderPathShared,
  findFolder as findFolderShared,
  flattenCollection,
  type RootScripts,
} from '@shared/collection-run/flatten';
import type { Collection } from '@shared/types';
import type { AuthConfig, CollectionItem, Request, ScopedVariable } from '@/types';
import { isConnectionPresetRequest } from '@/types';

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
  /** Folder names from the collection root to this request's parent. */
  folderPath?: string[];
  /** Folder variables in outermost-to-innermost order. */
  folderVariables?: ScopedVariable[][];
  request: Request;
  inheritedAuth?: AuthConfig;
  /**
   * Set when the Postman send guard refuses this request (explicit `noauth`
   * or unsupported Postman auth, #1232): the runner must not send it.
   * `inheritedAuth` is then an explicit `none`, never an ancestor credential.
   */
  blocked?: string;
}

export type { RootScripts };

export const findFolder = findFolderShared;
export const findFolderPath = findFolderPathShared;

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
  rootAuth?: AuthConfig,
  /** The collection itself, for the Postman send guard's root (sidecar + name). */
  root?: Collection
): RunnableRequest[] {
  return flattenCollection(items, {
    rootScripts,
    rootAuth,
    root,
    folderId,
    sender: 'Restura',
    guardOwner: 'name',
    // Connection presets (Kafka / MQTT #984, WebSocket / Socket.IO #1209) are
    // not runnable requests; `skippedConnectionPresets` reports them.
    leafAction: (item) =>
      item.request && isConnectionPresetRequest(item.request) ? 'skip' : 'run',
  }).map((leaf) => {
    const { item } = leaf;
    return {
      itemId: item.id,
      name: item.name,
      folderPath: leaf.folderPath,
      request: {
        ...item.request,
        preRequestScript: leaf.preRequestScript,
        testScript: leaf.testScript,
      } as Request,
      inheritedAuth: leaf.blocked ? { type: 'none' } : leaf.inheritedAuth,
      ...(leaf.blocked ? { blocked: leaf.blocked } : {}),
      ...(leaf.folderVariables.length > 0 ? { folderVariables: leaf.folderVariables } : {}),
    };
  });
}

/**
 * Names of the connection presets — Kafka / MQTT (#984), WebSocket / Socket.IO
 * (#1209) — in a run scope. They are not runnable requests, so the runner
 * leaves them out; the dialog reports them as skipped (the CLI prints the same
 * notice).
 */
export function skippedConnectionPresets(items: CollectionItem[], folderId?: string): string[] {
  const scope = folderId ? (findFolderPath(items, folderId)?.at(-1)?.items ?? []) : items;
  const out: string[] = [];
  const walk = (level: CollectionItem[]) => {
    for (const item of level) {
      if (item.request && isConnectionPresetRequest(item.request)) out.push(item.name);
      if (item.items) walk(item.items);
    }
  };
  walk(scope);
  return out;
}
