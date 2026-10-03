import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { CollectionItem } from '@/types';
import { addSampleCollection } from '../addSampleCollection';
import { buildSampleCollection, SAMPLE_COLLECTION_NAME } from '../sampleCollection';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

const requests = (items: CollectionItem[]): CollectionItem[] =>
  items.flatMap((i) => (i.type === 'folder' ? requests(i.items ?? []) : [i]));

describe('buildSampleCollection', () => {
  it('builds one ready-to-run request per savable protocol against the echo server', () => {
    const c = buildSampleCollection();
    expect(c.name).toBe(SAMPLE_COLLECTION_NAME);
    expect(c.items.some((i) => i.type === 'folder' && i.name === 'HTTP')).toBe(true);
    const reqs = requests(c.items).map((i) => i.request!);
    expect(reqs.map((r) => r.type).sort()).toEqual(['grpc', 'http', 'http', 'http', 'sse']);
    for (const r of reqs) {
      expect(Object.values(ECHO_URLS)).toContain(r.url);
    }
    // The POST uses the collection variable; the GET carries a test.
    expect(c.variables?.[0]?.key).toBe('greeting');
    expect(JSON.stringify(reqs)).toContain('{{greeting}}');
    expect(reqs.some((r) => r.type === 'http' && r.testScript?.includes('rs.test'))).toBe(true);
  });

  it('gives every build fresh ids', () => {
    expect(buildSampleCollection().id).not.toBe(buildSampleCollection().id);
  });
});

describe('addSampleCollection', () => {
  beforeEach(() => useCollectionStore.setState({ collections: [] }));

  it('adds the sample to the workspace', () => {
    addSampleCollection();
    expect(useCollectionStore.getState().collections.map((c) => c.name)).toEqual([
      SAMPLE_COLLECTION_NAME,
    ]);
  });
});
