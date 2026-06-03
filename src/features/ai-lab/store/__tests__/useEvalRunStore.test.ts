import { describe, it, expect, beforeEach } from 'vitest';
import { useEvalRunStore } from '../useEvalRunStore';
import type { EvalCellResult, EvalRun } from '../../types';

function reset() {
  useEvalRunStore.setState({ runs: {} });
}

function cell(passed: boolean): EvalCellResult {
  return {
    caseId: 'c',
    modelRef: { providerConfigId: 'p', model: 'm' },
    output: 'out',
    ok: true,
    latencyMs: 10,
    cost: 0,
    scores: [],
    passed,
  };
}

describe('useEvalRunStore lifecycle', () => {
  beforeEach(reset);

  it('starts a run in the running state with the right totals', () => {
    const id = useEvalRunStore
      .getState()
      .startRun({ evalConfigId: 'e', configName: 'My eval', totalCells: 4 });
    const run = useEvalRunStore.getState().runs[id];
    expect(run?.status).toBe('running');
    expect(run?.totalCells).toBe(4);
    expect(run?.cells).toHaveLength(0);
  });

  it('appends cells and finishes the run', () => {
    const id = useEvalRunStore
      .getState()
      .startRun({ evalConfigId: 'e', configName: 'n', totalCells: 2 });
    useEvalRunStore.getState().addCell(id, cell(true));
    useEvalRunStore.getState().addCell(id, cell(false));
    useEvalRunStore.getState().finishRun(id, 'done');
    const run = useEvalRunStore.getState().runs[id];
    expect(run?.cells).toHaveLength(2);
    expect(run?.status).toBe('done');
    expect(run?.finishedAt).toBeTypeOf('number');
  });

  it('addCell / finishRun on an unknown run id are no-ops', () => {
    useEvalRunStore.getState().addCell('nope', cell(true));
    useEvalRunStore.getState().finishRun('nope', 'done');
    expect(Object.keys(useEvalRunStore.getState().runs)).toHaveLength(0);
  });

  it('deletes a run', () => {
    const id = useEvalRunStore
      .getState()
      .startRun({ evalConfigId: 'e', configName: 'n', totalCells: 1 });
    useEvalRunStore.getState().deleteRun(id);
    expect(useEvalRunStore.getState().runs[id]).toBeUndefined();
  });

  it('lists runs newest-first', () => {
    const runs: Record<string, EvalRun> = {};
    for (let i = 0; i < 3; i++) {
      runs[`r${i}`] = {
        id: `r${i}`,
        evalConfigId: 'e',
        configName: `n${i}`,
        startedAt: i * 1000,
        status: 'done',
        cells: [],
        totalCells: 0,
      };
    }
    useEvalRunStore.setState({ runs });
    expect(
      useEvalRunStore
        .getState()
        .listRuns()
        .map((r) => r.id)
    ).toEqual(['r2', 'r1', 'r0']);
  });

  it('prunes to the 50 most recent runs when a new run starts', () => {
    const runs: Record<string, EvalRun> = {};
    for (let i = 1; i <= 50; i++) {
      runs[`r${i}`] = {
        id: `r${i}`,
        evalConfigId: 'e',
        configName: 'n',
        startedAt: i, // r1 is the oldest
        status: 'done',
        cells: [],
        totalCells: 0,
      };
    }
    useEvalRunStore.setState({ runs });
    // The new run has the latest Date.now() startedAt → the oldest (r1) is evicted.
    useEvalRunStore.getState().startRun({ evalConfigId: 'e', configName: 'fresh', totalCells: 0 });
    const all = useEvalRunStore.getState().runs;
    expect(Object.keys(all)).toHaveLength(50);
    expect(all.r1).toBeUndefined();
  });
});
