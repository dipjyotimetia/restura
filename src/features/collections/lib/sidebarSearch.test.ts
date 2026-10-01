import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem, HistoryItem, HttpRequest } from '@/types';
import {
  filterCollectionTree,
  groupHistory,
  historyBucket,
  historyItemMatches,
} from './sidebarSearch';

const http = (name: string, url = 'https://x.dev'): HttpRequest => ({
  id: name,
  name,
  type: 'http',
  method: 'GET',
  url,
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
});
const req = (name: string, url?: string): CollectionItem => ({
  id: name,
  name,
  type: 'request',
  request: http(name, url),
});
const folder = (name: string, items: CollectionItem[]): CollectionItem => ({
  id: name,
  name,
  type: 'folder',
  items,
});

const collections: Collection[] = [
  {
    id: 'c1',
    name: 'Shop API',
    items: [
      folder('Users', [req('List users'), folder('Admin', [req('Ban user', 'https/x.dev/ban')])]),
      req('Health'),
    ],
  },
  { id: 'c2', name: 'Billing', items: [req('Invoices', 'https://pay.dev/invoices')] },
];

describe('filterCollectionTree', () => {
  it('returns everything for an empty query', () => {
    expect(filterCollectionTree(collections, '  ')).toBe(collections);
  });

  it('finds requests nested in folders and keeps only the path to them', () => {
    const out = filterCollectionTree(collections, 'ban');
    expect(out).toHaveLength(1);
    const users = out[0]?.items[0];
    expect(users?.name).toBe('Users');
    expect(users?.items?.map((i) => i.name)).toEqual(['Admin']);
    expect(users?.items?.[0]?.items?.map((i) => i.name)).toEqual(['Ban user']);
  });

  it('keeps a whole subtree when a folder or collection name matches, and matches URLs', () => {
    expect(filterCollectionTree(collections, 'users')[0]?.items[0]?.items).toHaveLength(2);
    expect(filterCollectionTree(collections, 'shop')[0]).toBe(collections[0]);
    expect(filterCollectionTree(collections, 'pay.dev').map((c) => c.name)).toEqual(['Billing']);
    expect(filterCollectionTree(collections, 'zzz')).toEqual([]);
  });
});

describe('historyItemMatches', () => {
  const item = (request: HistoryItem['request'], resolvedUrl?: string): HistoryItem => ({
    id: 'h',
    request,
    timestamp: 0,
    ...(resolvedUrl ? { resolvedUrl } : {}),
  });

  it('matches name, URL, resolved URL and method', () => {
    const h = item(http('Get users', 'https://{{host}}/users'), 'https://api.dev/users');
    expect(historyItemMatches(h, 'get users')).toBe(true);
    expect(historyItemMatches(h, '{{host}}')).toBe(true);
    expect(historyItemMatches(h, 'api.dev')).toBe(true);
    expect(historyItemMatches(h, 'GET')).toBe(true);
    expect(historyItemMatches(h, 'post')).toBe(false);
    expect(historyItemMatches(h, '')).toBe(true);
  });

  it('matches gRPC service and method', () => {
    const grpc = item({
      id: 'g',
      name: 'Greet',
      type: 'grpc',
      url: 'localhost:50051',
      service: 'helloworld.Greeter',
      method: 'SayHello',
    } as HistoryItem['request']);
    expect(historyItemMatches(grpc, 'greeter')).toBe(true);
    expect(historyItemMatches(grpc, 'sayhello')).toBe(true);
  });
});

describe('history buckets', () => {
  const now = new Date(2026, 9, 1, 15, 0, 0).getTime(); // Thu 1 Oct, 15:00 local
  const at = (d: number, h = 12) => new Date(2026, 9, d, h, 0, 0).getTime();

  it('buckets by calendar day', () => {
    expect(historyBucket(at(1, 0), now)).toBe('Today');
    expect(historyBucket(new Date(2026, 8, 30, 23).getTime(), now)).toBe('Yesterday');
    expect(historyBucket(new Date(2026, 8, 26, 9).getTime(), now)).toBe('Earlier this week');
    expect(historyBucket(new Date(2026, 8, 24, 9).getTime(), now)).toBe('Older');
  });

  it('groups consecutive items, preserving order', () => {
    const items = [
      { timestamp: at(1) },
      { timestamp: at(1, 9) },
      { timestamp: new Date(2026, 8, 1).getTime() },
    ];
    expect(groupHistory(items, now).map((g) => [g.bucket, g.items.length])).toEqual([
      ['Today', 2],
      ['Older', 1],
    ]);
  });
});
