import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkbench } from '../AgentWorkbench';
import { useAiLabStore } from '../../store/useAiLabStore';
import { useAiLabUiStore } from '../../store/useAiLabUiStore';
import {
  resetAgentRunServiceForTests,
  setAgentRunRepositoryForTests,
  startAgentRun,
  useAgentRunLiveStore,
} from '../../run-engine/agentRunService';

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

  it('cancels the active job and rejects late success', async () => {
    let resolve!: (report: typeof REPORT) => void;
    runDesktopAgentSuite.mockImplementation(
      () => new Promise<typeof REPORT>((done) => (resolve = done))
    );
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => resolve(REPORT));

    expect(await screen.findByRole('status')).toHaveTextContent('CANCELLED');
    expect(save).not.toHaveBeenCalled();
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

  it('retains late completion in memory without saving or navigating after unmount', async () => {
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

    expect(save).not.toHaveBeenCalled();
    expect(useAiLabUiStore.getState().tab).toBe('agents');
    expect(useAgentRunLiveStore.getState().completedReport).toMatchObject({
      kind: 'agent-suite',
      status: 'passed',
    });
    expect(useAgentRunLiveStore.getState().persistedReportId).not.toBe(
      useAgentRunLiveStore.getState().completedReport?.id
    );
    expect(useAgentRunLiveStore.getState().persistenceError).toMatch(/pending/i);
  });

  it('refuses a new run while a late completion is still pending persistence', async () => {
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
    const pending = useAgentRunLiveStore.getState().completedReport;

    expect(startAgentRun(SUITE, {})).toBe(false);
    expect(useAgentRunLiveStore.getState().completedReport).toBe(pending);
    expect(useAgentRunLiveStore.getState().persistenceError).toMatch(/pending/i);
    expect(runDesktopAgentSuite).toHaveBeenCalledTimes(1);
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
