import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useFileCollectionStore } from '@/store/useFileCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { Collection, HttpRequest, RequestTab } from '@/types';
import { deleteCollectionWithCleanup } from '../deleteCollection';

const request: HttpRequest = {
  id: 'request',
  name: 'Saved',
  type: 'http',
  method: 'GET',
  url: 'https://example.com',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};
const collection: Collection = {
  id: 'collection',
  name: 'Collection',
  items: [{ id: 'item', name: 'Saved', type: 'request', request }],
};

describe('deleteCollectionWithCleanup', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [collection] });
    useFileCollectionStore.setState({ fileCollections: {}, conflicts: [] });
    useFileCollectionStore.getState().registerFileCollection('collection', '/tmp/collection');
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab',
          request,
          savedRequestId: 'item',
          isDirty: false,
        } as RequestTab,
      ],
      activeTabId: 'tab',
    });
    useWorkflowStore.setState({
      workflows: [
        {
          id: 'workflow',
          collectionId: 'collection',
          document: {
            document: { dsl: '1.0.3', namespace: 'restura', name: 'workflow', version: '1.0.0' },
            do: [{ initialize: { wait: { milliseconds: 0 } } }],
          },
          bindings: { version: 1, tasks: {} },
          layout: { version: 1, nodes: {} },
          createdAt: 1,
          updatedAt: 1,
        },
      ] as never,
    });
    useCollectionRunStore.setState({
      runs: [
        {
          id: 'run',
          collectionId: 'collection',
          collectionName: 'Collection',
          scopeName: 'Collection',
          startedAt: 1,
          durationMs: 1,
          iterations: 1,
          dataRows: 0,
          outcome: 'completed',
          requests: [],
          summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        },
      ],
    });
  });

  it('unwatches, deletes workflows, detaches tabs, and retains run history', async () => {
    const unwatchDirectory = vi.fn().mockResolvedValue({ success: true });
    window.electron = { collections: { unwatchDirectory } } as unknown as typeof window.electron;

    await expect(deleteCollectionWithCleanup('collection')).resolves.toEqual({ success: true });

    expect(unwatchDirectory).toHaveBeenCalledWith('/tmp/collection');
    expect(useCollectionStore.getState().collections).toEqual([]);
    expect(useFileCollectionStore.getState().fileCollections).toEqual({});
    expect(useWorkflowStore.getState().workflows).toEqual([]);
    expect(useRequestStore.getState().tabs[0]).toMatchObject({ isDirty: true });
    expect(useRequestStore.getState().tabs[0]).not.toHaveProperty('savedRequestId');
    expect(useCollectionRunStore.getState().runs).toHaveLength(1);
  });
});
