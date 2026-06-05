import { v4 as uuidv4 } from 'uuid';
import type { Collection, CollectionItem, HttpRequest, Request } from '@/types';

/**
 * Factories for new collection-tree nodes created from the Sidebar UI.
 *
 * Folders and saved requests are both `CollectionItem`s discriminated by
 * `type`. The store (`useCollectionStore.addItemToCollection`) already nests
 * these arbitrarily; these helpers just mint well-formed nodes so the UI
 * never hand-rolls a partial shape. A new request defaults to a blank GET so
 * the user lands in the builder ready to type a URL — unlike `useRequestStore`'s
 * tab default, which seeds the echo URL for quick experimentation.
 */

export function makeFolderItem(name = 'New Folder'): CollectionItem {
  return { id: uuidv4(), name, type: 'folder', items: [] };
}

function blankHttpRequest(name: string): HttpRequest {
  return {
    id: uuidv4(),
    name,
    type: 'http',
    method: 'GET',
    url: '',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
}

export function makeRequestItem(name = 'New Request'): CollectionItem {
  return { id: uuidv4(), name, type: 'request', request: blankHttpRequest(name) };
}

/**
 * Clone a request item with fresh ids (item id and the inner request id) so
 * the duplicate is an independent saved request, not an alias of the source.
 */
export function duplicateRequestItem(item: CollectionItem): CollectionItem {
  const baseName = `${item.name} copy`;
  if (item.type !== 'request' || !item.request) {
    return { ...makeFolderItem(baseName) };
  }
  const clonedRequest = {
    ...structuredClone(item.request),
    id: uuidv4(),
    name: baseName,
  } as Request;
  return { id: uuidv4(), name: baseName, type: 'request', request: clonedRequest };
}

/**
 * Deep-clone a whole collection with fresh ids at every level — the
 * collection itself, every folder/request item, every inner request, and
 * every collection-variable row — so the duplicate is fully independent of
 * the source (open tabs, runs, and file-collection registrations key off
 * these ids). The clone is mutated in place; the source is untouched.
 *
 * SecretRef handle ids are deliberately NOT re-minted: both collections
 * reference the same keychain entry, which is safe today because deleting a
 * collection never reaps handles (removeCollection just filters the array).
 * If handle reaping is ever added to the delete path, this sharing must be
 * revisited — deleting the original would silently break the duplicate's auth.
 */
export function duplicateCollection(collection: Collection): Collection {
  const dup = structuredClone(collection);
  dup.id = uuidv4();
  dup.name = `${collection.name} copy`;
  const reId = (items: CollectionItem[]) => {
    for (const item of items) {
      item.id = uuidv4();
      if (item.request) item.request.id = uuidv4();
      if (item.items) reId(item.items);
    }
  };
  reId(dup.items);
  dup.variables?.forEach((v) => (v.id = uuidv4()));
  return dup;
}
