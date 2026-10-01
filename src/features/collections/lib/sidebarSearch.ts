import type { Collection, CollectionItem, HistoryItem } from '@/types';

/**
 * Prune collections to what matches `query` (case-insensitive substring).
 * A collection or folder whose own name matches keeps its whole subtree;
 * otherwise only matching descendants (and the folders leading to them) stay.
 * Requests also match on their URL.
 */
export function filterCollectionTree(collections: Collection[], query: string): Collection[] {
  const q = query.trim().toLowerCase();
  if (!q) return collections;
  const out: Collection[] = [];
  for (const collection of collections) {
    if (collection.name.toLowerCase().includes(q)) {
      out.push(collection);
      continue;
    }
    const items = pruneItems(collection.items, q);
    if (items.length > 0) out.push({ ...collection, items });
  }
  return out;
}

function itemMatches(item: CollectionItem, q: string): boolean {
  if (item.name.toLowerCase().includes(q)) return true;
  const url = item.request && 'url' in item.request ? item.request.url : undefined;
  return typeof url === 'string' && url.toLowerCase().includes(q);
}

function pruneItems(items: CollectionItem[], q: string): CollectionItem[] {
  const out: CollectionItem[] = [];
  for (const item of items) {
    if (itemMatches(item, q)) {
      out.push(item);
    } else if (item.type === 'folder') {
      const children = pruneItems(item.items ?? [], q);
      if (children.length > 0) out.push({ ...item, items: children });
    }
  }
  return out;
}

/** Whether a history entry matches the sidebar search text. */
export function historyItemMatches(item: HistoryItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const r = item.request;
  const fields: Array<string | undefined> = [r.name, item.resolvedUrl];
  if ('url' in r) fields.push(r.url);
  if (r.type === 'http') fields.push(r.method);
  if (r.type === 'grpc') fields.push(r.service, r.method);
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
}

export type HistoryBucket = 'Today' | 'Yesterday' | 'Earlier this week' | 'Older';

/** Calendar bucket for a history timestamp, relative to `now` (local time). */
export function historyBucket(timestamp: number, now: number = Date.now()): HistoryBucket {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (timestamp >= today) return 'Today';
  if (timestamp >= today - day) return 'Yesterday';
  if (timestamp >= today - 6 * day) return 'Earlier this week';
  return 'Older';
}

/** Group newest-first history into consecutive date buckets, preserving order. */
export function groupHistory<T extends { timestamp: number }>(
  items: T[],
  now: number = Date.now()
): Array<{ bucket: HistoryBucket; items: T[] }> {
  const groups: Array<{ bucket: HistoryBucket; items: T[] }> = [];
  for (const item of items) {
    const bucket = historyBucket(item.timestamp, now);
    const last = groups[groups.length - 1];
    if (last?.bucket === bucket) last.items.push(item);
    else groups.push({ bucket, items: [item] });
  }
  return groups;
}
