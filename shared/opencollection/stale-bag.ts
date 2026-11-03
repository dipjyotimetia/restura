/**
 * Stale OpenCollection folder bags.
 *
 * A folder's `_oc` bag is its verbatim imported node: `info` (description and
 * other extras), `docs`, the `request` defaults (headers, settings, auth,
 * scripts, variables) and its `items`. Once anything in the folder's subtree
 * changes (a child edited, added, removed or moved; the folder itself renamed
 * or moved) the cached `items` are wrong, but the folder's own metadata is
 * not: Restura does not model most of it, so the bag is its only copy.
 *
 * `shared/collections/tree-edit.ts` therefore never deletes a folder's bag on
 * such an edit. It replaces it with {@link staleFolderBag} (metadata only, no
 * `items`) and sets {@link OC_STALE_KEY} on the node. The exporter
 * (`from-internal.ts`) then rebuilds the folder from the stale bag (keeping the
 * metadata, re-applying what the internal model owns: name, auth, scripts,
 * variables, children) and never emits it verbatim.
 */

/** Node-level marker set next to a stale `_oc` folder bag. */
export const OC_STALE_KEY = '_ocStale';

type Bag = Record<string, unknown>;

function isPlainObject(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True for a bag shaped like an OC folder (no `info.type`). Unknown-type item
 * placeholders are internal folders too, but their bag is the opaque item.
 */
export function isOcFolderBag(bag: unknown): bag is Bag {
  if (!isPlainObject(bag)) return false;
  const info = bag.info;
  return isPlainObject(info) && typeof info.type !== 'string';
}

/**
 * The metadata-only copy of a folder's `_oc` bag (its `items` dropped), or
 * `undefined` when the bag is not an OC folder and must be dropped instead.
 */
export function staleFolderBag(bag: unknown): Bag | undefined {
  if (!isOcFolderBag(bag)) return undefined;
  const metadata: Bag = { ...bag };
  delete metadata.items;
  return metadata;
}

/**
 * Whether `node`'s `_oc` bag must not be emitted verbatim. Besides the marker,
 * a folder that has children but whose folder-shaped bag carries no `items`
 * is stale by construction (fail-safe if a copy ever loses the marker).
 */
export function isOcBagStale(node: object): boolean {
  if (Reflect.get(node, OC_STALE_KEY) === true) return true;
  const bag = Reflect.get(node, '_oc');
  const children = Reflect.get(node, 'items');
  return (
    Array.isArray(children) &&
    children.length > 0 &&
    isOcFolderBag(bag) &&
    !Array.isArray(bag.items)
  );
}
