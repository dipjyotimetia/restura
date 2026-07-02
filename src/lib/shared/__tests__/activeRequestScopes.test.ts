import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types/http';
import { buildActiveRequestValueMap } from '../activeRequestScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useRequestStore } from '@/store/useRequestStore';

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
});
