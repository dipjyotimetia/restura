import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { EvalCellResult, EvalConfig } from '../../types';

const mockRunEval = vi.hoisted(() => vi.fn());
vi.mock('@/features/ai-lab/lib/evalRunner', () => ({ runEval: mockRunEval }));

import { useEvalRun } from '../useEvalRun';
import { useAiLabStore } from '../../store/useAiLabStore';
import { useEvalRunStore } from '../../store/useEvalRunStore';
import { setAiLabReportRepositoryForTests } from '../../run-engine/reportRepository';

const CELL: EvalCellResult = {
  caseId: 'c1',
  modelRef: { providerConfigId: 'p1', model: 'm' },
  output: 'out',
  ok: true,
  latencyMs: 10,
  cost: 0,
  scores: [],
  passed: true,
};

function seedConfig(): EvalConfig {
  useAiLabStore.setState({
    providers: {},
    prompts: { pr: { id: 'pr', name: 'p', system: '', user: 'u', createdAt: 0, updatedAt: 0 } },
    datasets: {
      ds: { id: 'ds', name: 'd', cases: [{ id: 'c1', vars: {} }], createdAt: 0, updatedAt: 0 },
    },
    evalConfigs: {},
    favoriteModelKeys: [],
    recentModelKeys: [],
  });
  return {
    id: 'cfg',
    name: 'eval',
    promptId: 'pr',
    datasetId: 'ds',
    models: [{ providerConfigId: 'p1', model: 'm' }],
    scorers: [],
    concurrency: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('useEvalRun', () => {
  beforeEach(() => {
    mockRunEval.mockReset();
    useEvalRunStore.setState({ runs: {} });
    useAiLabStore.setState({ runReports: {} });
    setAiLabReportRepositoryForTests({ load: async () => ({}), save: async () => {} });
  });

  it('keeps a failed report save available and retries it through the awaited repository', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValueOnce(undefined);
    setAiLabReportRepositoryForTests({ load: async () => ({}), save });
    mockRunEval.mockImplementation(async (_input, onProgress: (p: unknown) => void) => {
      onProgress({ completed: 1, total: 1, cells: [CELL], done: true });
      return [CELL];
    });
    const config = seedConfig();
    const { result } = renderHook(() => useEvalRun());

    await act(async () => {
      result.current.start(config);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.persistenceError).toMatch(/report persistence failed.*quota/i);
    expect(result.current.pendingReport).toMatchObject({ kind: 'eval', status: 'passed' });
    expect(useAiLabStore.getState().runReports).toEqual({});

    await act(async () => {
      await result.current.retrySave();
    });

    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.pendingReport).toBeNull();
    expect(Object.values(useAiLabStore.getState().runReports)).toHaveLength(1);
  });

  it('refuses a later eval while a failed report save is still pending', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
    setAiLabReportRepositoryForTests({
      load: async () => ({}),
      save,
    });
    mockRunEval.mockImplementation(async (_input, onProgress: (p: unknown) => void) => {
      onProgress({ completed: 1, total: 1, cells: [CELL], done: true });
      return [CELL];
    });
    const config = seedConfig();
    const { result } = renderHook(() => useEvalRun());

    await act(async () => {
      result.current.start(config);
      await Promise.resolve();
      await Promise.resolve();
    });
    const pendingId = result.current.pendingReport?.id;

    act(() => result.current.start(config));

    expect(mockRunEval).toHaveBeenCalledTimes(1);
    expect(result.current.pendingReport?.id).toBe(pendingId);
    expect(result.current.persistenceError).toMatch(/retry.*save/i);

    await act(async () => {
      await result.current.retrySave();
    });
  });

  it('starts a run, persists cells + a done status, and surfaces progress', async () => {
    mockRunEval.mockImplementation(async (_input, onProgress: (p: unknown) => void) => {
      onProgress({ completed: 1, total: 1, cells: [CELL], done: true });
      return [CELL];
    });
    const config = seedConfig();
    const { result } = renderHook(() => useEvalRun());

    await act(async () => {
      result.current.start(config);
      await Promise.resolve();
    });

    const runs = Object.values(useEvalRunStore.getState().runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('done');
    expect(runs[0]?.cells).toHaveLength(1);
    expect(result.current.progress?.done).toBe(true);
    expect(result.current.running).toBe(false);
    expect(useAiLabStore.getState().recentModelKeys).toEqual(['p1:m']);
    expect(useAiLabStore.getState().runReports[runs[0]!.id]).toMatchObject({
      kind: 'eval',
      status: 'passed',
      payload: runs[0],
    });
  });

  it('errors when the prompt or dataset is missing', async () => {
    useAiLabStore.setState({ providers: {}, prompts: {}, datasets: {}, evalConfigs: {} });
    const { result } = renderHook(() => useEvalRun());
    await act(async () => {
      result.current.start({
        id: 'c',
        name: 'e',
        promptId: 'missing',
        datasetId: 'missing',
        models: [],
        scorers: [],
        concurrency: 1,
        createdAt: 0,
        updatedAt: 0,
      });
    });
    expect(result.current.error).toMatch(/missing its prompt or dataset/i);
    expect(mockRunEval).not.toHaveBeenCalled();
  });

  it('marks the run errored when the runner rejects', async () => {
    mockRunEval.mockRejectedValue(new Error('boom'));
    const config = seedConfig();
    const { result } = renderHook(() => useEvalRun());
    await act(async () => {
      result.current.start(config);
      await Promise.resolve();
    });
    const runs = Object.values(useEvalRunStore.getState().runs);
    expect(runs[0]?.status).toBe('error');
    expect(result.current.error).toBe('boom');
  });

  it('cancellation wins over a runner that resolves successfully after stop', async () => {
    let resolve!: (cells: EvalCellResult[]) => void;
    mockRunEval.mockImplementation(() => new Promise<EvalCellResult[]>((done) => (resolve = done)));
    const config = seedConfig();
    const { result } = renderHook(() => useEvalRun());

    await act(async () => {
      result.current.start(config);
      result.current.stop();
      resolve([CELL]);
      await Promise.resolve();
    });

    const run = Object.values(useEvalRunStore.getState().runs)[0]!;
    expect(run.status).toBe('cancelled');
    expect(useAiLabStore.getState().runReports[run.id]).toMatchObject({
      kind: 'eval',
      status: 'cancelled',
    });
    expect(useAiLabStore.getState().runReports[run.id]).not.toMatchObject({ status: 'passed' });
  });
});
