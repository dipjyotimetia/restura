import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetAgentRunServiceForTests,
  setAgentRunRepositoryForTests,
  startAgentRun,
  useAgentRunLiveStore,
} from '../../run-engine/agentRunService';
import { useAiLabStore } from '../../store/useAiLabStore';
import { useAiLabUiStore } from '../../store/useAiLabUiStore';
import { AgentWorkbench } from '../AgentWorkbench';

const runDesktopAgentSuite = vi.hoisted(() => vi.fn());
vi.mock('../../lib/agentRuntime', () => ({ runDesktopAgentSuite }));

const REPORT = {
  suiteId: 'suite-1',
  status: 'passed' as const,
  results: [],
  summary: {
    total: 1,
    passed: 1,
    failed: 0,
    errors: 0,
    cancelled: 0,
    passRate: 1,
    confidence95: { low: 0.2, high: 1 },
    passAtK: { 1: 1 },
    passToK: { 1: 1 },
    reliabilityByCase: [],
  },
};

const PARTIAL_REPORT = {
  ...REPORT,
  results: [
    {
      taskId: 'task',
      agentId: 'agent',
      trial: 1,
      status: 'passed' as const,
      output: [{ type: 'text' as const, text: 'partial output' }],
      trace: {
        id: 'trace',
        suiteId: 'suite-1',
        taskId: 'task',
        trial: 1,
        agentId: 'agent',
        startedAt: 1,
        events: [
          {
            id: 'event',
            traceId: 'trace',
            sequence: 0,
            timestamp: 1,
            type: 'model.completed' as const,
            providerId: 'provider',
            model: 'model',
            output: [{ type: 'text' as const, text: 'partial output' }],
            durationMs: 2,
            usage: { inputTokens: 3, outputTokens: 4 },
          },
        ],
      },
      scores: [
        {
          graderId: 'judge',
          kind: 'judge' as const,
          passed: true,
          resourceCalls: { attempted: 1, usageKnown: 1, costKnown: 0 },
        },
      ],
    },
  ],
};

const SUITE = {
  schemaVersion: 2 as const,
  id: 'suite-1',
  name: 'Cancellation suite',
  mode: 'regression' as const,
  agents: [
    {
      id: 'agent',
      model: { providerId: 'provider', model: 'model' },
      instructions: 'Do it',
      tools: [],
      limits: { maxSteps: 2, maxWallTimeMs: 1_000, maxToolCalls: 1 },
    },
  ],
  tasks: [{ id: 'task', input: [{ type: 'text' as const, text: 'input' }] }],
  graders: [],
  trials: 1,
};

describe('AgentWorkbench runs', () => {
  const save = vi.fn(async () => {});
  const load = vi.fn(async () => ({}));
  beforeEach(() => {
    runDesktopAgentSuite.mockReset();
    save.mockReset();
    load.mockReset();
    load.mockResolvedValue({});
    save.mockResolvedValue(undefined);
    resetAgentRunServiceForTests();
    setAgentRunRepositoryForTests({ load, save });
    useAiLabStore.setState({
      providers: {},
      prompts: {},
      datasets: {},
      evalConfigs: {},
      favoriteModelKeys: [],
      recentModelKeys: [],
      agentSuites: {},
      runReports: {},
    });
    useAiLabUiStore.setState({ tab: 'agents', reportRunId: null });
  });

  it('persists a sanitized cancelled report from late partial success without navigating', async () => {
    let resolve!: (report: typeof PARTIAL_REPORT) => void;
    runDesktopAgentSuite.mockImplementation(
      () => new Promise<typeof PARTIAL_REPORT>((done) => (resolve = done))
    );
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => resolve(PARTIAL_REPORT));

    expect(await screen.findByRole('status')).toHaveTextContent('CANCELLED');
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(useAgentRunLiveStore.getState().completedReport).toMatchObject({
      status: 'cancelled',
      payload: {
        status: 'cancelled',
        results: [
          {
            trace: { events: [{ usage: { inputTokens: 3, outputTokens: 4 } }] },
            scores: [{ resourceCalls: { attempted: 1, usageKnown: 1, costKnown: 0 } }],
          },
        ],
      },
    });
    expect(useAiLabUiStore.getState()).toMatchObject({ tab: 'agents', reportRunId: null });
  });

  it('persists the complete agent report and opens Reports', async () => {
    runDesktopAgentSuite.mockResolvedValue(REPORT);
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });

    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const reports = useAiLabStore.getState().runReports;
    const envelope = Object.values(reports)[0];
    expect(envelope).toMatchObject({ kind: 'agent-suite', payload: REPORT, suite: SUITE });
    expect(useAiLabUiStore.getState()).toMatchObject({
      tab: 'reports',
      reportRunId: envelope?.id,
    });
  });

  it('preserves the active run and Cancel across unmount/remount', async () => {
    let resolve!: (report: typeof REPORT) => void;
    runDesktopAgentSuite.mockImplementation(
      () => new Promise<typeof REPORT>((done) => (resolve = done))
    );
    const user = userEvent.setup();
    const first = render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    first.unmount();

    render(<AgentWorkbench />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => resolve(REPORT));
    expect(await screen.findByRole('status')).toHaveTextContent('CANCELLED');
  });

  it('rejects a concurrent start', () => {
    runDesktopAgentSuite.mockImplementation(() => new Promise(() => {}));
    expect(startAgentRun(SUITE, {})).toBe(true);
    expect(startAgentRun(SUITE, {})).toBe(false);
  });

  it('persists late completion without navigating after unmount', async () => {
    let resolve!: (report: typeof REPORT) => void;
    runDesktopAgentSuite.mockImplementation(
      () => new Promise<typeof REPORT>((done) => (resolve = done))
    );
    const user = userEvent.setup();
    const view = render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    view.unmount();
    await act(async () => resolve(REPORT));

    expect(save).toHaveBeenCalledOnce();
    expect(useAiLabUiStore.getState().tab).toBe('agents');
    expect(useAgentRunLiveStore.getState().completedReport).toMatchObject({
      kind: 'agent-suite',
      status: 'passed',
    });
    expect(useAgentRunLiveStore.getState().persistedReportId).toBe(
      useAgentRunLiveStore.getState().completedReport?.id
    );
    expect(useAgentRunLiveStore.getState().persistenceError).toBeNull();
  });

  it('does not let a remount navigate for the original unmounted owner', async () => {
    let resolveRun!: (report: typeof REPORT) => void;
    let resolveSave!: () => void;
    runDesktopAgentSuite.mockImplementation(
      () => new Promise<typeof REPORT>((done) => (resolveRun = done))
    );
    save.mockImplementationOnce(() => new Promise<void>((done) => (resolveSave = done)));
    const first = render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    first.unmount();
    await act(async () => resolveRun(REPORT));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());

    render(<AgentWorkbench />);
    await act(async () => resolveSave());

    expect(useAiLabUiStore.getState().tab).toBe('agents');
  });

  it('allows a new run after an unmounted owner completion was persisted', async () => {
    let resolve!: (report: typeof REPORT) => void;
    runDesktopAgentSuite.mockImplementation(
      () => new Promise<typeof REPORT>((done) => (resolve = done))
    );
    const view = render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    view.unmount();
    await act(async () => resolve(REPORT));
    runDesktopAgentSuite.mockImplementationOnce(() => new Promise(() => {}));

    expect(startAgentRun(SUITE, {})).toBe(true);
    expect(useAgentRunLiveStore.getState().persistenceError).toBeNull();
    expect(runDesktopAgentSuite).toHaveBeenCalledTimes(2);
  });

  it('retains a completed report after save failure and retries successfully', async () => {
    save.mockRejectedValueOnce(new Error('quota exceeded')).mockResolvedValueOnce(undefined);
    runDesktopAgentSuite.mockResolvedValue(REPORT);
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });
    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/persistence failed.*quota/i);
    expect(screen.getByRole('button', { name: 'View report' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(Object.values(useAiLabStore.getState().runReports)).toHaveLength(1);
  });
});
