import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { protocolRegistry } from '@/features/registry/registry';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { OwsStoredWorkflow } from '@/store/useWorkflowStore';
import { useOwsWorkflowExecution } from '../useOwsWorkflowExecution';

const runRequest = vi.fn();
const injectVariables = vi.fn((request) => request);

const workflow: OwsStoredWorkflow = {
  id: 'workflow-1',
  collectionId: 'collection-1',
  document: {
    document: { dsl: '1.0.3', namespace: 'restura', name: 'native', version: '1.0.0' },
    do: [
      {
        request: {
          call: 'http',
          with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
        },
      },
    ],
  },
  bindings: {
    version: 1,
    tasks: {
      '/do/0/request': {
        kind: 'saved-request',
        call: 'http',
        resourceId: 'Saved%20request',
      },
    },
  },
  layout: { version: 1, nodes: {} },
  createdAt: 1,
  updatedAt: 1,
};

describe('useOwsWorkflowExecution', () => {
  beforeEach(() => {
    runRequest.mockReset();
    injectVariables.mockClear();
    vi.spyOn(protocolRegistry, 'get').mockReturnValue({
      id: 'http',
      label: 'HTTP',
      tabType: 'http',
      defaultRequest: vi.fn(),
      injectVariables,
      runRequest,
    });
    useCollectionStore.setState({
      collections: [
        {
          id: 'collection-1',
          name: 'Collection',
          auth: { type: 'none' },
          variables: [{ key: 'collectionVar', value: 'collection', enabled: true }],
          items: [
            {
              id: 'item-1',
              name: 'Saved request',
              type: 'request',
              request: {
                id: 'request-1',
                name: 'Saved request',
                type: 'http',
                method: 'GET',
                url: 'https://example.test/saved',
                headers: [],
                params: [],
                body: { type: 'none' },
                auth: { type: 'none' },
              },
            },
          ],
        },
      ],
    } as never);
    useGlobalsStore.setState({ vars: { globalVar: 'global' } });
    useEnvironmentStore.setState({ activeEnvironmentId: null, environments: [] });
  });

  it('runs only the saved HTTP resource through the registered protocol adapter', async () => {
    runRequest.mockResolvedValue({ status: 200, headers: {}, body: 'ok', size: 2, time: 1 });
    const { result } = renderHook(() => useOwsWorkflowExecution());

    await act(async () => {
      await result.current.run(workflow);
    });

    expect(injectVariables).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'http', url: 'https://example.test/saved' }),
      expect.objectContaining({ globalVar: 'global', collectionVar: 'collection' })
    );
    expect(runRequest).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'http', url: 'https://example.test/saved' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result.current.result?.status).toBe('success');
  });

  it('resolves a Git-stable saved-request logical path instead of a regenerated request id', async () => {
    runRequest.mockResolvedValue({ status: 200, headers: {}, body: 'ok', size: 2, time: 1 });
    useCollectionStore.setState({
      collections: [
        {
          id: 'collection-1',
          name: 'Collection',
          auth: { type: 'none' },
          variables: [],
          items: [
            {
              id: 'folder-1',
              name: 'Users',
              type: 'folder',
              items: [
                {
                  id: 'item-1',
                  name: 'Saved request',
                  type: 'request',
                  request: {
                    id: 'regenerated-runtime-id',
                    name: 'Saved request',
                    type: 'http',
                    method: 'GET',
                    url: 'https://example.test/saved',
                    headers: [],
                    params: [],
                    body: { type: 'none' },
                    auth: { type: 'none' },
                  },
                },
              ],
            },
          ],
        },
      ],
    } as never);
    const pathBoundWorkflow: OwsStoredWorkflow = {
      ...workflow,
      bindings: {
        version: 1,
        tasks: {
          '/do/0/request': {
            kind: 'saved-request',
            call: 'http',
            resourceId: 'Users/Saved%20request',
          },
        },
      },
    };
    const { result } = renderHook(() => useOwsWorkflowExecution());

    await act(async () => {
      await result.current.run(pathBoundWorkflow);
    });

    expect(runRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.test/saved' }),
      expect.anything()
    );
  });
});
