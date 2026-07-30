import { beforeEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types/http';
import {
  buildActiveRequestValueMap,
  buildActiveRequestVariableResolution,
  findAncestorFolderVariables,
} from '../activeRequestScopes';

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'req',
    name: 'R',
    type: 'http',
    method: 'GET',
    url: 'https://x',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

describe('buildActiveRequestValueMap', () => {
  beforeEach(() => {
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useGlobalsStore.setState({ vars: {} });
    useCollectionStore.setState({ collections: [] });
    useRequestStore.setState({ tabs: [], activeTabId: null });
    localStorage.clear();
  });

  it('merges env + globals + the active tab collection with correct precedence', () => {
    const env = useEnvironmentStore.getState().createNewEnvironment('E');
    useEnvironmentStore.getState().addEnvironment(env);
    useEnvironmentStore
      .getState()
      .addVariable(env.id, { id: 'e', key: 'envVar', value: 'ev', enabled: true });
    useEnvironmentStore
      .getState()
      .addVariable(env.id, { id: 'd', key: 'dup', value: 'fromEnv', enabled: true });
    useEnvironmentStore.getState().setActiveEnvironment(env.id);

    useGlobalsStore.getState().set('gVar', 'gv');
    useGlobalsStore.getState().set('dup', 'fromGlobal');

    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'C',
          items: [{ id: 'item-1', name: 'R', type: 'request', request: makeRequest() }],
          variables: [
            { id: 'cv', key: 'colVar', value: 'cv', enabled: true },
            { id: 'cd', key: 'dup', value: 'fromCollection', enabled: true },
          ],
        },
      ],
    });
    useRequestStore.getState().openTab(makeRequest(), { savedRequestId: 'item-1' });

    const map = buildActiveRequestValueMap();
    expect(map.envVar).toBe('ev');
    expect(map.gVar).toBe('gv');
    expect(map.colVar).toBe('cv');
    // Precedence: collection > env > global.
    expect(map.dup).toBe('fromCollection');
  });

  it('omits collection vars when the active tab has no savedRequestId', () => {
    useGlobalsStore.getState().set('gVar', 'gv');
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'C',
          items: [{ id: 'item-1', name: 'R', type: 'request', request: makeRequest() }],
          variables: [{ id: 'cv', key: 'colVar', value: 'cv', enabled: true }],
        },
      ],
    });
    // Ad-hoc tab (no savedRequestId) — not opened from the collection tree.
    useRequestStore.getState().openTab(makeRequest());

    const map = buildActiveRequestValueMap();
    expect(map.gVar).toBe('gv');
    expect('colVar' in map).toBe(false);
  });

  it('includes a selected environment chain and only ancestor folder variables', () => {
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'base',
          name: 'Base',
          variables: [{ id: 'base-v', key: 'shared', value: 'base', enabled: true }],
        },
        {
          id: 'sub',
          name: 'Prod',
          parentId: 'base',
          variables: [{ id: 'sub-v', key: 'shared', value: 'sub', enabled: true }],
        },
      ],
      activeEnvironmentId: 'base',
    });
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'C',
          variables: [{ id: 'collection-v', key: 'shared', value: 'collection', enabled: true }],
          items: [
            {
              id: 'folder',
              name: 'Folder',
              type: 'folder',
              variables: [{ id: 'folder-v', key: 'shared', value: 'folder', enabled: true }],
              items: [{ id: 'item-1', name: 'R', type: 'request', request: makeRequest() }],
            },
          ],
        },
      ],
    });
    useRequestStore.getState().openTab(makeRequest(), { savedRequestId: 'item-1' });

    expect(buildActiveRequestValueMap()).toMatchObject({ shared: 'folder' });
  });

  it('does not apply a collection-owned environment to a different collection', () => {
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'owned',
          name: 'Owned',
          collectionId: 'c1',
          variables: [{ id: 'owned-v', key: 'host', value: 'wrong-collection', enabled: true }],
        },
      ],
      activeEnvironmentId: 'owned',
    });
    useCollectionStore.setState({
      collections: [
        {
          id: 'c2',
          name: 'Other',
          items: [{ id: 'item-2', name: 'R', type: 'request', request: makeRequest() }],
        },
      ],
    });
    useRequestStore.getState().openTab(makeRequest(), { savedRequestId: 'item-2' });

    expect(buildActiveRequestValueMap()).not.toHaveProperty('host');
  });

  it('keeps winning SecretRef variables opaque while a later plaintext scope clears them', () => {
    useEnvironmentStore.setState({
      environments: [
        {
          id: 'base',
          name: 'Base',
          variables: [
            {
              id: 'secret',
              key: 'token',
              value: '',
              enabled: true,
              secretRef: { kind: 'inline', value: 'desktop-only' },
            },
            {
              id: 'disabled',
              key: 'disabled',
              value: '',
              enabled: false,
              secretRef: { kind: 'inline', value: 'ignored' },
            },
            { id: 'empty-key', key: '', value: 'ignored', enabled: true },
          ],
        },
        {
          id: 'sub',
          name: 'Sub',
          parentId: 'base',
          variables: [{ id: 'plain', key: 'token', value: 'sub', enabled: true }],
        },
      ],
      activeEnvironmentId: 'base',
    });

    expect(buildActiveRequestVariableResolution()).toEqual({
      values: {},
      secretVariables: { token: { kind: 'inline', value: 'desktop-only' } },
    });

    useEnvironmentStore.getState().setActiveEnvironment('sub');

    expect(buildActiveRequestVariableResolution()).toEqual({
      values: { token: 'sub' },
      secretVariables: {},
    });
  });

  it('returns no ancestors for an empty folder subtree', () => {
    expect(
      findAncestorFolderVariables(
        [{ id: 'empty-folder', name: 'Empty', type: 'folder', items: undefined }],
        'missing-request'
      )
    ).toBeUndefined();
  });
});
