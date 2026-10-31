import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunArena = vi.hoisted(() => vi.fn());
vi.mock('@/features/ai-lab/lib/arenaRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/arenaRunner')>();
  return { ...actual, runArena: mockRunArena };
});

import { setAiLabReportRepositoryForTests } from '../../run-engine/reportRepository';
import { useAiLabStore } from '../../store/useAiLabStore';
import { useArenaStore } from '../../store/useArenaStore';
import { useArenaRun } from '../useArenaRun';

const MODELS = [
  { providerConfigId: 'p', model: 'a' },
  { providerConfigId: 'p', model: 'b' },
];

function config() {
  return {
    datasetId: 'ds',
    datasetName: 'Dataset',
    models: MODELS,
    modelLabels: { 'p:a': 'A', 'p:b': 'B' },
    judgeModel: { providerConfigId: 'p', model: 'judge' },
    concurrency: 1,
  };
}

describe('useArenaRun on the RunEngine (#1046)', () => {
  beforeEach(() => {
    mockRunArena.mockReset();
    useArenaStore.setState({ runs: {} });
    useAiLabStore.setState({
      runReports: {},
      providers: {},
      datasets: {
        ds: {
          id: 'ds',
          name: 'Dataset',
          cases: [{ id: 'c1', vars: {} }],
          createdAt: 0,
          updatedAt: 0,
        },
      },
      favoriteModelKeys: [],
      recentModelKeys: [],
    });
    setAiLabReportRepositoryForTests({ load: async () => ({}), save: async () => {} });
  });

  it('persists a finished run to the arena history and the Reports tab', async () => {
    mockRunArena.mockResolvedValue({
      matches: [{ a: 'p:a', b: 'p:b', winner: 'a' }],
      modelKeys: ['p:a', 'p:b'],
    });
    const { result } = renderHook(() => useArenaRun());
    act(() => result.current.start(config()));
    await waitFor(() => expect(result.current.running).toBe(false));
    const runId = result.current.lastRunId!;
    await waitFor(() => expect(useAiLabStore.getState().runReports[runId]).toBeDefined());
    expect(useArenaStore.getState().runs[runId]?.status).toBe('done');
    const report = useAiLabStore.getState().runReports[runId]!;
    expect(report.kind).toBe('arena');
    expect(report.status).toBe('passed');
  });

  it('reports a partial run as failed with a reason', async () => {
    mockRunArena.mockResolvedValue({
      matches: [
        { a: 'p:a', b: 'p:b', winner: 'a' },
        { a: 'p:a', b: 'p:b', winner: 'error', error: 'boom' },
      ],
      modelKeys: ['p:a', 'p:b'],
    });
    const { result } = renderHook(() => useArenaRun());
    act(() => result.current.start(config()));
    await waitFor(() => expect(result.current.running).toBe(false));
    const runId = result.current.lastRunId!;
    await waitFor(() => expect(useAiLabStore.getState().runReports[runId]).toBeDefined());
    const report = useAiLabStore.getState().runReports[runId]!;
    expect(report.status).toBe('failed');
    expect(report.statusReason).toBe('1 of 2 matches failed');
    expect(useArenaStore.getState().runs[runId]?.status).toBe('partial');
  });

  it('Stop cancels through the engine signal and keeps the matches judged so far', async () => {
    mockRunArena.mockImplementation(
      (_input: unknown, _onProgress: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ matches: [{ a: 'p:a', b: 'p:b', winner: 'b' }], modelKeys: ['p:a', 'p:b'] })
          );
        })
    );
    const { result } = renderHook(() => useArenaRun());
    act(() => result.current.start(config()));
    expect(result.current.running).toBe(true);
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.running).toBe(false));
    const run = useArenaStore.getState().runs[result.current.lastRunId!]!;
    expect(run.status).toBe('cancelled');
    expect(run.matches).toHaveLength(1);
  });

  it('a failed report save surfaces an error but does not block the next run', async () => {
    setAiLabReportRepositoryForTests({
      load: async () => ({}),
      save: async () => {
        throw new Error('quota');
      },
    });
    mockRunArena.mockResolvedValue({ matches: [], modelKeys: ['p:a', 'p:b'] });
    const { result } = renderHook(() => useArenaRun());
    act(() => result.current.start(config()));
    await waitFor(() => expect(result.current.persistenceError).toMatch(/quota/));
    act(() => result.current.start(config()));
    await waitFor(() => expect(mockRunArena).toHaveBeenCalledTimes(2));
  });
});
