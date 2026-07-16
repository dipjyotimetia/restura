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
import { useCollectionStore } from '@/store/useCollectionStore';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { AgentWorkbench } from '../AgentWorkbench';

const runDesktopAgentSuite = vi.hoisted(() => vi.fn());
const runDesktopAgentBundle = vi.hoisted(() => vi.fn());
vi.mock('../../lib/agentRuntime', () => ({ runDesktopAgentBundle, runDesktopAgentSuite }));

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
    runDesktopAgentBundle.mockReset();
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
    useCollectionStore.setState({ collections: [], activeCollectionId: null });
    useMcpStore.setState({ connections: {}, activeConnectionId: null });
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
    expect(envelope).toMatchObject({
      kind: 'agent-suite',
      payload: REPORT,
      suite: { ...SUITE, schemaVersion: 3, grounding: { sourceIds: [], maxBytes: 16_384 } },
    });
    expect(useAiLabUiStore.getState()).toMatchObject({
      tab: 'reports',
      reportRunId: envelope?.id,
    });
  });

  it('runs a fixture bundle through the desktop bundle runtime', async () => {
    runDesktopAgentBundle.mockResolvedValue({
      report: REPORT,
      gates: [{ metric: 'passRate', expected: 1, actual: 1, passed: true }],
    });
    const bundle = {
      schemaVersion: 1,
      id: 'fixture-bundle',
      name: 'Fixture bundle',
      suite: {
        ...SUITE,
        agents: [{ ...SUITE.agents[0]!, tools: [{ kind: 'fixture', fixtureId: 'hello' }] }],
      },
      fixtures: [
        {
          id: 'hello',
          tool: {
            name: 'hello_tool',
            description: 'Return hello.',
            inputSchema: { type: 'object', additionalProperties: false },
          },
          output: [{ type: 'text', text: 'hello' }],
        },
      ],
      baseline: { minPassRate: 1 },
    };
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(bundle) },
    });

    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(runDesktopAgentBundle).toHaveBeenCalledOnce());
    expect(runDesktopAgentBundle).toHaveBeenCalledWith(
      expect.objectContaining({ suite: expect.objectContaining({ schemaVersion: 3 }) }),
      expect.anything(),
      expect.anything()
    );
  });

  it('edits grounding on the nested suite when a v2 bundle is loaded', async () => {
    useCollectionStore.setState({
      collections: [{ id: 'orders', name: 'Orders', items: [] }],
      activeCollectionId: 'orders',
    });
    const bundle = {
      schemaVersion: 1,
      id: 'grounded-bundle',
      name: 'Grounded bundle',
      suite: { ...SUITE },
      fixtures: [],
    };
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(bundle) },
    });

    await user.click(screen.getByRole('button', { name: 'Collection · Orders' }));

    const parsed = JSON.parse(
      (screen.getByLabelText('Agent suite JSON') as HTMLTextAreaElement).value
    );
    expect(parsed.suite).toMatchObject({
      schemaVersion: 3,
      grounding: { sourceIds: ['orders'], maxBytes: 16_384 },
    });

    await user.click(screen.getByRole('button', { name: 'Collection · Orders' }));
    expect(
      JSON.parse((screen.getByLabelText('Agent suite JSON') as HTMLTextAreaElement).value).suite
        .grounding.sourceIds
    ).toEqual([]);
  });

  it('edits grounding directly on a standalone suite', async () => {
    useCollectionStore.setState({
      collections: [{ id: 'orders', name: 'Orders', items: [] }],
      activeCollectionId: 'orders',
    });
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });
    await user.click(screen.getByRole('button', { name: 'Collection · Orders' }));
    expect(
      JSON.parse((screen.getByLabelText('Agent suite JSON') as HTMLTextAreaElement).value)
    ).toMatchObject({
      schemaVersion: 3,
      grounding: { sourceIds: ['orders'], maxBytes: 16_384 },
    });
  });

  it('saves normalized suites and validates bundles without adding them to desktop storage', async () => {
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });
    await user.click(screen.getByRole('button', { name: 'Save suite' }));
    expect(useAiLabStore.getState().agentSuites['suite-1']).toMatchObject({
      schemaVersion: 3,
      grounding: { sourceIds: [], maxBytes: 16_384 },
    });

    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: {
        value: JSON.stringify({
          schemaVersion: 1,
          id: 'bundle',
          name: 'Bundle',
          suite: SUITE,
          fixtures: [],
        }),
      },
    });
    await user.click(screen.getByRole('button', { name: 'Save suite' }));
    expect(useAiLabStore.getState().agentSuites.bundle).toBeUndefined();
    expect(screen.getByRole('status')).toHaveTextContent('Bundle schema-validated');
  });

  it('exports both normalized suites and bundles', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });
    await user.click(screen.getByRole('button', { name: 'Export' }));

    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: {
        value: JSON.stringify({
          schemaVersion: 1,
          id: 'bundle',
          name: 'Bundle',
          suite: SUITE,
          fixtures: [],
        }),
      },
    });
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('imports standalone suites and bundles and leaves invalid JSON editable', async () => {
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    const input = screen.getByLabelText('Import agent suite');
    await user.upload(input, new File([JSON.stringify(SUITE)], 'suite.json'));
    await waitFor(() => expect(useAiLabStore.getState().agentSuites['suite-1']).toBeDefined());

    const bundle = { schemaVersion: 1, id: 'bundle', name: 'Bundle', suite: SUITE, fixtures: [] };
    await user.upload(input, new File([JSON.stringify(bundle)], 'bundle.json'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Bundle imported'));

    await user.upload(input, new File(['not json'], 'invalid.json'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/unexpected token/i));
  });

  it('reports malformed draft errors from save, export, run, and grounding controls', async () => {
    useCollectionStore.setState({
      collections: [{ id: 'orders', name: 'Orders', items: [] }],
      activeCollectionId: 'orders',
    });
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), { target: { value: '{' } });

    await user.click(screen.getByRole('button', { name: 'Save suite' }));
    expect(screen.getByRole('status')).toHaveTextContent(/expected property name/i);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('status')).toHaveTextContent(/expected property name/i);
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('status')).toHaveTextContent(/expected property name/i);
    await user.click(screen.getByRole('button', { name: 'Collection · Orders' }));
    expect(screen.getByRole('status')).toHaveTextContent(/fix suite json/i);
  });

  it('selects and removes saved suites and renders MCP grounding choices', async () => {
    useAiLabStore.setState({
      agentSuites: {
        'suite-1': { ...SUITE, schemaVersion: 3, grounding: { sourceIds: [], maxBytes: 1 } },
      },
    });
    useMcpStore.setState({
      connections: {
        profile: {
          id: 'profile',
          url: 'https://mcp.example.test',
          transport: 'streamable-http',
          headers: [],
          status: 'disconnected',
          capabilities: {
            serverName: 'Catalog',
            serverVersion: '1',
            tools: [],
            resources: [],
            prompts: [],
          },
          log: [],
          createdAt: 0,
        },
      },
      activeConnectionId: null,
    });
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    await user.click(screen.getByRole('button', { name: /Cancellation suite/ }));
    expect((screen.getByLabelText('Agent suite JSON') as HTMLTextAreaElement).value).toContain(
      'suite-1'
    );
    expect(screen.getByRole('button', { name: 'MCP · Catalog' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete suite' }));
    expect(useAiLabStore.getState().agentSuites['suite-1']).toBeUndefined();
  });

  it('handles empty imports, MCP fallback labels, and persisted-run status controls', async () => {
    useMcpStore.setState({
      connections: {
        profile: {
          id: 'profile',
          url: '',
          transport: 'streamable-http',
          headers: [],
          status: 'disconnected',
          capabilities: null,
          log: [],
          createdAt: 0,
        },
      },
      activeConnectionId: null,
    });
    useAgentRunLiveStore.setState({
      running: false,
      status: 'PERSISTENCE ERROR',
      persistenceError: 'quota',
      completedReport: { id: 'report-1' } as never,
    });
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Import agent suite'), { target: { files: [] } });
    expect(screen.getByRole('button', { name: 'MCP · profile' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'MCP · profile' }));
    expect((screen.getByLabelText('Agent suite JSON') as HTMLTextAreaElement).value).toContain(
      '"profile"'
    );
    expect(screen.getByRole('status')).toHaveTextContent('PERSISTENCE ERROR · quota');
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'View report' })).toBeVisible();
  });

  it.each([
    [true, 'approved'],
    [false, 'denied'],
  ])('forwards %s approval decisions from the workbench', async (confirmed, decision) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(confirmed);
    confirm.mockClear();
    runDesktopAgentSuite.mockImplementationOnce(
      async (
        _suite: unknown,
        _providers: unknown,
        options: {
          requestApproval?: (request: {
            approvalId: string;
            toolCallId: string;
            toolName: string;
            arguments: unknown;
            permissionClass: 'mutation';
          }) => Promise<'approved' | 'denied'>;
        }
      ) => {
        const approval = await options.requestApproval?.({
          approvalId: 'approval',
          toolCallId: 'call',
          toolName: 'write',
          arguments: { id: '1' },
          permissionClass: 'mutation',
        });
        expect(approval).toBe(decision);
        return REPORT;
      }
    );
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(SUITE) },
    });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  });

  it('marks a desktop bundle report failed when its committed baseline regresses', async () => {
    runDesktopAgentBundle.mockResolvedValue({
      report: { ...REPORT, status: 'failed' },
      gates: [{ metric: 'passRate', expected: 1, actual: 0, passed: false }],
    });
    const bundle = {
      schemaVersion: 1,
      id: 'regressed-bundle',
      name: 'Regressed bundle',
      suite: { ...SUITE },
      fixtures: [],
      baseline: { minPassRate: 1 },
    };
    const user = userEvent.setup();
    render(<AgentWorkbench />);
    fireEvent.change(screen.getByLabelText('Agent suite JSON'), {
      target: { value: JSON.stringify(bundle) },
    });

    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByRole('status')).toHaveTextContent('FAILED');
    expect(useAgentRunLiveStore.getState().completedReport?.payload.status).toBe('failed');
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
