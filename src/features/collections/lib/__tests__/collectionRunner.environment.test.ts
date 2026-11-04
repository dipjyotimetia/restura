import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@/features/registry/types';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { Response as ApiResponse, Collection, HttpRequest } from '@/types';
import type { RunnableRequest } from '../flattenRunnables';

const phases: Array<Record<string, string | null> | undefined> = [];
const seenVariables: Array<Record<string, string>> = [];

const runRequestMock = vi.fn(async (_req: unknown, ctx: RunContext): Promise<ApiResponse> => {
  seenVariables.push({ ...ctx.variables });
  const mutations = phases.shift();
  if (mutations) {
    const variables = { ...ctx.variables };
    for (const [key, value] of Object.entries(mutations)) {
      if (value === null) delete variables[key];
      else variables[key] = value;
    }
    ctx.onScriptResult?.({
      test: {
        success: true,
        logs: [],
        errors: [],
        variables,
        environmentMutations: mutations,
      } as never,
    });
  }
  return {
    id: 'r',
    requestId: 'req',
    status: 200,
    statusText: 'OK',
    headers: {},
    body: '',
    size: 0,
    time: 1,
    timestamp: Date.now(),
  };
});

vi.mock('@/features/registry/registry', () => ({
  protocolRegistry: {
    get: (id: string) => (id === 'http' ? { id: 'http', runRequest: runRequestMock } : undefined),
  },
}));

import { runCollection } from '../collectionRunner';

function runnable(id: string): RunnableRequest {
  const request: HttpRequest = {
    id,
    name: id,
    type: 'http',
    method: 'GET',
    url: 'https://example.test',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  };
  return { itemId: id, name: id, request };
}

const collection: Collection = { id: 'c', name: 'C', items: [] };

beforeEach(() => {
  phases.length = 0;
  seenVariables.length = 0;
  useCollectionStore.setState({ collections: [collection], activeCollectionId: null });
  useEnvironmentStore.setState({
    environments: [
      {
        id: 'env1',
        name: 'Env',
        variables: [
          { id: 'v1', key: 'stale', value: 'x', enabled: true },
          { id: 'v2', key: 'base', value: 'b', enabled: true },
        ],
      },
    ],
    activeEnvironmentId: 'env1',
  });
});

describe('runCollection — pm.environment writes', () => {
  it('persists them to the run’s environment and carries them to later requests', async () => {
    phases.push({ token: 't-1', stale: null }, undefined);
    await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('login'), runnable('me')],
        baseVars: { stale: 'x', base: 'b' },
        environmentVars: { stale: 'x', base: 'b' },
        environmentId: 'env1',
        environmentName: 'Env',
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      () => {},
      new AbortController().signal
    );
    expect(seenVariables[1]?.token).toBe('t-1');
    const variables = useEnvironmentStore.getState().environments[0]?.variables ?? [];
    expect(Object.fromEntries(variables.map((v) => [v.key, v.value]))).toEqual({
      base: 'b',
      token: 't-1',
    });
  });

  it('does not write anywhere when the run has no environment', async () => {
    phases.push({ token: 't-1' });
    await runCollection(
      {
        collection,
        scopeName: 'C',
        runnables: [runnable('login')],
        baseVars: {},
        iterations: 1,
        dataRows: [],
        delayMs: 0,
        stopOnFailure: false,
      },
      () => {},
      new AbortController().signal
    );
    const variables = useEnvironmentStore.getState().environments[0]?.variables ?? [];
    expect(variables.map((v) => v.key)).toEqual(['stale', 'base']);
  });
});
