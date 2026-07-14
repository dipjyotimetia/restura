import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types/http';
import { useVariableStatus } from '../useVariableStatus';

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    id: 'req-1',
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

describe('useVariableStatus', () => {
  beforeEach(() => {
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useGlobalsStore.setState({ vars: {} });
    useCollectionStore.setState({ collections: [] });
    useRequestStore.setState({ tabs: [], activeTabId: null });
    localStorage.clear();
  });

  it('classifies an active-environment variable as resolved', () => {
    const env = useEnvironmentStore.getState().createNewEnvironment('E');
    useEnvironmentStore.getState().addEnvironment(env);
    useEnvironmentStore
      .getState()
      .addVariable(env.id, { id: 'v', key: 'baseUrl', value: 'x', enabled: true });
    useEnvironmentStore.getState().setActiveEnvironment(env.id);

    const { result } = renderHook(() => useVariableStatus());
    expect(result.current('baseUrl')).toBe('resolved');
    expect(result.current('nope')).toBe('unresolved');
  });

  it('classifies a workspace global as resolved', () => {
    useGlobalsStore.getState().set('gVar', 'g');
    const { result } = renderHook(() => useVariableStatus());
    expect(result.current('gVar')).toBe('resolved');
  });

  it('resolves a collection variable via the active tab savedRequestId', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c1',
          name: 'C',
          items: [
            { id: 'item-1', name: 'R', type: 'request', request: makeRequest({ id: 'item-1' }) },
          ],
          variables: [{ id: 'cv', key: 'colVar', value: 'cv', enabled: true }],
        },
      ],
    });
    useRequestStore.getState().openTab(makeRequest(), { savedRequestId: 'item-1' });

    const { result } = renderHook(() => useVariableStatus());
    expect(result.current('colVar')).toBe('resolved');
  });

  it('resolves a statically-parsed pre-request script set() key', () => {
    useRequestStore
      .getState()
      .openTab(makeRequest({ preRequestScript: `pm.environment.set('token', 'x')` }));

    const { result } = renderHook(() => useVariableStatus());
    expect(result.current('token')).toBe('resolved');
  });

  it('classifies dynamic helpers correctly', () => {
    const { result } = renderHook(() => useVariableStatus());
    expect(result.current('$randomUUID')).toBe('resolved');
    expect(result.current('$notAHelper')).toBe('unresolved');
  });
});
