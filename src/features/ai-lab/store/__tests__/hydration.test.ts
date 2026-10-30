import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => ({
  items: new Map<string, unknown>(),
  strict: new Map<string, unknown>(),
}));

vi.mock('@/lib/shared/dexie-storage', () => {
  const adapter = (table: string) => () => ({
    getItem: async (name: string) => mem.items.get(`${table}/${name}`) ?? null,
    setItem: async (name: string, value: unknown) => {
      mem.items.set(`${table}/${name}`, value);
    },
    removeItem: async (name: string) => {
      mem.items.delete(`${table}/${name}`);
    },
  });
  return {
    dexieStorageAdapters: {
      aiLab: adapter('aiLab'),
      evalRuns: adapter('evalRuns'),
      arenaRuns: adapter('arenaRuns'),
    },
    setDexieStorageItemStrict: async (table: string, name: string, value: unknown) => {
      mem.strict.set(`${table}/${name}`, value);
    },
    getDexieStorageItemStrict: async () => null,
  };
});
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import { useAiLabStore } from '../useAiLabStore';
import { useArenaStore } from '../useArenaStore';
import { useEvalRunStore } from '../useEvalRunStore';

function quarantined(prefix: string): unknown[] {
  return [...mem.strict.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
}

const dataset = (id: string) => ({ id, name: id, cases: [], createdAt: 1, updatedAt: 1 });
const evalCell = {
  caseId: 'c',
  modelRef: { providerConfigId: 'p', model: 'm' },
  output: 'o',
  ok: true,
  latencyMs: 1,
  cost: 0,
  scores: [],
  passed: true,
};
const evalRun = (id: string, status: string) => ({
  id,
  evalConfigId: 'e',
  configName: 'n',
  startedAt: 1,
  status,
  cells: [evalCell],
  totalCells: 1,
});
const arenaRun = (id: string, status: string) => ({
  id,
  datasetId: 'd',
  datasetName: 'd',
  modelKeys: ['a', 'b'],
  modelLabels: {},
  matches: [{ a: 'a', b: 'b', winner: 'a' }],
  startedAt: 1,
  status,
});

describe('per-record hydration recovery (#1030)', () => {
  beforeEach(() => {
    mem.items.clear();
    mem.strict.clear();
  });

  it('keeps valid datasets when one is corrupt and writes a quarantine key', async () => {
    mem.items.set('aiLab/ai-lab-store', {
      version: 4,
      state: {
        providers: {},
        prompts: {},
        datasets: { good: dataset('good'), bad: { id: 'bad', name: 42 } },
        evalConfigs: {},
        favoriteModelKeys: [],
        recentModelKeys: [],
        agentSuites: {},
        reportQuarantineCount: 0,
      },
    });
    await useAiLabStore.persist.rehydrate();
    expect(Object.keys(useAiLabStore.getState().datasets)).toEqual(['good']);
    await vi.waitFor(() => expect(quarantined('aiLab/ai-lab-store__invalid-')).toHaveLength(1));
    expect(quarantined('aiLab/ai-lab-store__invalid-')[0]).toEqual({
      datasets: { bad: { id: 'bad', name: 42 } },
    });
  });

  it('drops only the invalid eval run', async () => {
    mem.items.set('evalRuns/eval-runs-store', {
      version: 1,
      state: {
        runs: {
          ok: evalRun('ok', 'done'),
          bad: { ...evalRun('bad', 'done'), cells: 'nope' },
        },
      },
    });
    await useEvalRunStore.persist.rehydrate();
    expect(Object.keys(useEvalRunStore.getState().runs)).toEqual(['ok']);
    await vi.waitFor(() =>
      expect(quarantined('evalRuns/eval-runs-store__invalid-')).toHaveLength(1)
    );
  });

  it('drops only the invalid arena run', async () => {
    mem.items.set('arenaRuns/arena-runs-store', {
      version: 1,
      state: {
        runs: { ok: arenaRun('ok', 'done'), bad: { ...arenaRun('bad', 'done'), matches: 7 } },
      },
    });
    await useArenaStore.persist.rehydrate();
    expect(Object.keys(useArenaStore.getState().runs)).toEqual(['ok']);
    await vi.waitFor(() =>
      expect(quarantined('arenaRuns/arena-runs-store__invalid-')).toHaveLength(1)
    );
  });

  it('restores an interrupted eval run as cancelled and flags it interrupted', async () => {
    mem.items.set('evalRuns/eval-runs-store', {
      version: 1,
      state: { runs: { r: evalRun('r', 'running'), d: evalRun('d', 'done') } },
    });
    await useEvalRunStore.persist.rehydrate();
    const runs = useEvalRunStore.getState().runs;
    expect(runs.r).toMatchObject({ status: 'cancelled', interrupted: true });
    expect(runs.r?.finishedAt).toBeTypeOf('number');
    expect(runs.d?.status).toBe('done');
    expect(runs.d).not.toHaveProperty('interrupted');
  });

  it('restores an interrupted arena run as cancelled and flags it interrupted', async () => {
    mem.items.set('arenaRuns/arena-runs-store', {
      version: 1,
      state: { runs: { r: arenaRun('r', 'running') } },
    });
    await useArenaStore.persist.rehydrate();
    expect(useArenaStore.getState().runs.r).toMatchObject({
      status: 'cancelled',
      interrupted: true,
    });
    expect(useArenaStore.getState().runs.r?.matches).toHaveLength(1);
  });

  it('keeps partial arena runs and errored matches through hydration (#1023)', async () => {
    mem.items.set('arenaRuns/arena-runs-store', {
      version: 1,
      state: {
        runs: {
          p: {
            ...arenaRun('p', 'partial'),
            matches: [
              { a: 'a', b: 'b', winner: 'a' },
              { a: 'a', b: 'b', winner: 'error', error: 'bad key' },
            ],
          },
        },
      },
    });
    await useArenaStore.persist.rehydrate();
    expect(useArenaStore.getState().runs.p?.status).toBe('partial');
    expect(useArenaStore.getState().runs.p?.matches[1]?.winner).toBe('error');
    expect(quarantined('arenaRuns/')).toHaveLength(0);
  });
});
