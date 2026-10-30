import type { AgentSuite, AgentSuiteReport } from '@shared/agent-lab';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runDesktopAgentSuite = vi.hoisted(() => vi.fn());
vi.mock('../../lib/agentRuntime', () => ({
  runDesktopAgentBundle: vi.fn(),
  runDesktopAgentSuite,
}));

import {
  dismissAgentReport,
  resetAgentRunServiceForTests,
  setAgentRunRepositoryForTests,
  startAgentRun,
  useAgentRunLiveStore,
} from '../agentRunService';

const SUITE: AgentSuite = {
  schemaVersion: 2,
  id: 'suite-1',
  name: 'Suite',
  mode: 'regression',
  agents: [
    {
      id: 'agent',
      model: { providerId: 'provider', model: 'model' },
      instructions: 'Do it',
      tools: [],
      limits: { maxSteps: 2, maxWallTimeMs: 1_000 },
    },
  ],
  tasks: [{ id: 'task', input: [{ type: 'text', text: 'input' }] }],
  graders: [],
  trials: 1,
};

const EMPTY_SUMMARY = {
  total: 0,
  passed: 0,
  failed: 0,
  errors: 0,
  cancelled: 0,
  passRate: 0,
  confidence95: { low: 0, high: 0 },
  passAtK: {},
  passToK: {},
  reliabilityByCase: [],
};

const REPORT: AgentSuiteReport = {
  suiteId: 'suite-1',
  status: 'passed',
  results: [],
  summary: EMPTY_SUMMARY,
};

/** Even after aggressive truncation (4 KiB/string) this stays above the 2 MiB cap. */
function oversizedReport(): AgentSuiteReport {
  return {
    ...REPORT,
    results: Array.from({ length: 700 }, (_, index) => ({
      taskId: 'task',
      agentId: 'agent',
      trial: index + 1,
      status: 'passed' as const,
      output: [{ type: 'text' as const, text: 'x'.repeat(4_000) }],
      trace: {
        id: `trace-${index}`,
        suiteId: 'suite-1',
        taskId: 'task',
        trial: index + 1,
        agentId: 'agent',
        startedAt: 1,
        events: [],
      },
      scores: [],
    })),
  };
}

async function settled() {
  await vi.waitFor(() => expect(useAgentRunLiveStore.getState().running).toBe(false));
}

describe('agent report persistence failures (#1031)', () => {
  const save = vi.fn(async () => {});
  beforeEach(() => {
    runDesktopAgentSuite.mockReset();
    save.mockReset();
    resetAgentRunServiceForTests();
    setAgentRunRepositoryForTests({ load: async () => ({}), save });
  });

  it('lets the user dismiss a failed save so new runs are no longer blocked', async () => {
    save.mockRejectedValue(new Error('quota'));
    runDesktopAgentSuite.mockResolvedValue(REPORT);
    expect(startAgentRun(SUITE, {})).toBe(true);
    await settled();
    await vi.waitFor(() =>
      expect(useAgentRunLiveStore.getState().persistenceError).toMatch(/quota/)
    );

    expect(startAgentRun(SUITE, {})).toBe(false);
    dismissAgentReport();
    expect(useAgentRunLiveStore.getState().completedReport).toBeNull();
    expect(useAgentRunLiveStore.getState().persistenceError).toBeNull();
    expect(startAgentRun(SUITE, {})).toBe(true);
    await settled();
  });

  it('surfaces an oversized report instead of dropping it, keeping it exportable', async () => {
    runDesktopAgentSuite.mockResolvedValue(oversizedReport());
    expect(startAgentRun(SUITE, {})).toBe(true);
    await settled();

    const live = useAgentRunLiveStore.getState();
    expect(live.persistenceError).toMatch(/too large.*export/i);
    expect(live.completedReport?.kind).toBe('agent-suite');
    expect(live.persistedReportId).toBeNull();
    expect(save).not.toHaveBeenCalled();

    dismissAgentReport();
    expect(startAgentRun(SUITE, {})).toBe(true);
    await settled();
  });
});
