import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkbench } from '../AgentWorkbench';
import { useAiLabStore } from '../../store/useAiLabStore';
import { useAiLabUiStore } from '../../store/useAiLabUiStore';

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
  schemaVersion: 2,
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
  beforeEach(() => {
    runDesktopAgentSuite.mockReset();
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
    const saveRunReport = vi.spyOn(useAiLabStore.getState(), 'saveRunReport');
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => resolve(REPORT));

    expect(await screen.findByRole('status')).toHaveTextContent('CANCELLED');
    expect(saveRunReport).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'passed' }));
  });

  it('persists the complete agent report and opens Reports', async () => {
    runDesktopAgentSuite.mockResolvedValue(REPORT);
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });

    await user.click(screen.getByRole('button', { name: 'Run' }));

    const reports = useAiLabStore.getState().runReports;
    const envelope = Object.values(reports)[0];
    expect(envelope).toMatchObject({ kind: 'agent-suite', payload: REPORT, suite: SUITE });
    expect(useAiLabUiStore.getState()).toMatchObject({
      tab: 'reports',
      reportRunId: envelope?.id,
    });
  });
});
