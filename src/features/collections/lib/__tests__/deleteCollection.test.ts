import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useFileCollectionStore } from '@/store/useFileCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { Collection, HttpRequest, RequestTab } from '@/types';
import { deleteCollectionWithCleanup, describeCollectionDeletion } from '../deleteCollection';

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

describe('describeCollectionDeletion', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [collection] });
    useFileCollectionStore.setState({ fileCollections: {}, conflicts: [] });
    useWorkflowStore.setState({
      workflows: [{ id: 'w', collectionId: 'collection' }] as never,
    });
  });

  it('names the collection, counts requests and linked workflows', () => {
    expect(describeCollectionDeletion('collection')).toBe(
      'Delete "Collection" with 1 request and its 1 linked workflow? Open tabs stay open as unsaved copies.'
    );
  });

  it('states that files on disk are kept for a file-backed collection', () => {
    useFileCollectionStore.getState().registerFileCollection('collection', '/tmp/collection');
    expect(describeCollectionDeletion('collection')).toContain(
      'The files in /tmp/collection stay on disk'
    );
  });
});

describe('deleteCollectionWithCleanup undo', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [collection] });
    useFileCollectionStore.setState({ fileCollections: {}, conflicts: [] });
    useWorkflowStore.setState({
      workflows: [
        {
          id: 'w',
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
  });

  it('restores the collection and its workflows', async () => {
    const result = await deleteCollectionWithCleanup('collection', { undoable: true });
    expect(result.success).toBe(true);
    expect(useCollectionStore.getState().collections).toEqual([]);
    expect(useWorkflowStore.getState().workflows).toEqual([]);
    result.undo?.restore();
    expect(useCollectionStore.getState().collections.map((c) => c.id)).toEqual(['collection']);
    expect(useWorkflowStore.getState().workflows.map((w) => w.id)).toEqual(['w']);
  });

  it('offers no undo for a file-backed collection', async () => {
    useFileCollectionStore.getState().registerFileCollection('collection', '/tmp/collection');
    window.electron = {
      collections: { unwatchDirectory: vi.fn().mockResolvedValue({ success: true }) },
    } as unknown as typeof window.electron;
    const result = await deleteCollectionWithCleanup('collection', { undoable: true });
    expect(result.success).toBe(true);
    expect(result.undo).toBeUndefined();
  });
});
