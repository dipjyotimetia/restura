import { describe, it, expect, beforeEach } from 'vitest';
import { useLoadTestStore, type LoadTestRun } from '../useLoadTestStore';
import type { LoadStats } from '@/lib/shared/loadStats';

const stats: LoadStats = {
  count: 1, errors: 0, min: 1, max: 1, mean: 1, p50: 1, p90: 1, p95: 1, p99: 1, rps: 1,
};

function run(id: string): LoadTestRun {
  return {
    id,
    method: 'GET',
    url: 'https://api.example/x',
    requestName: 'x',
    request: { id, name: 'x', type: 'http', method: 'GET', url: 'https://api.example/x', headers: [], params: [], body: { type: 'none' }, auth: { type: 'none' } } as never,
    stats,
    rps: 1,
    completedAt: Date.now(),
  };
}

describe('useLoadTestStore', () => {
  beforeEach(() => useLoadTestStore.setState({ runs: [] }));

  it('prepends new runs (most recent first)', () => {
    useLoadTestStore.getState().addRun(run('a'));
    useLoadTestStore.getState().addRun(run('b'));
    expect(useLoadTestStore.getState().runs.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('caps history at 20 runs', () => {
    for (let i = 0; i < 25; i++) useLoadTestStore.getState().addRun(run(`r${i}`));
    expect(useLoadTestStore.getState().runs).toHaveLength(20);
    expect(useLoadTestStore.getState().runs[0]?.id).toBe('r24');
  });

  it('clears runs', () => {
    useLoadTestStore.getState().addRun(run('a'));
    useLoadTestStore.getState().clearRuns();
    expect(useLoadTestStore.getState().runs).toEqual([]);
  });
});
