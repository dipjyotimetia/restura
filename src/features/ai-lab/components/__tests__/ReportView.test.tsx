import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiLabReportEnvelope } from '../../run-engine/reportEnvelope';
import { useAiLabStore } from '../../store/useAiLabStore';
import { useAiLabUiStore } from '../../store/useAiLabUiStore';
import { useEvalRunStore } from '../../store/useEvalRunStore';
import type { EvalRun } from '../../types';
import { ReportView } from '../ReportView';

const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('@/lib/shared/file-utils', () => ({ downloadBlob }));

const REPORT: AiLabReportEnvelope = {
  id: 'report-1',
  kind: 'agent-suite',
  name: 'Checkout agent',
  startedAt: 10,
  finishedAt: 20,
  status: 'failed',
  suite: {
    schemaVersion: 2,
    id: 'suite-1',
    name: 'Checkout agent',
    mode: 'regression',
    agents: [
      {
        id: 'agent',
        model: { providerId: 'provider', model: 'model' },
        instructions: 'Complete checkout',
        tools: [],
        limits: { maxSteps: 2, maxWallTimeMs: 1000, maxToolCalls: 1 },
      },
    ],
    tasks: [
      {
        id: 'checkout',
        input: [{ type: 'text', text: 'Buy one book' }],
        reference: [{ type: 'text', text: 'Order confirmed' }],
      },
    ],
    graders: [],
    trials: 1,
  },
  payload: {
    suiteId: 'suite-1',
    status: 'failed',
    execution: {
      modelCapabilities: [
        {
          providerId: 'provider',
          model: 'model',
          capabilities: {
            inputModalities: ['text'],
            outputModalities: ['text'],
            structuredOutput: false,
            toolCalling: true,
            parallelToolCalls: false,
            reasoning: false,
            continuation: false,
            serverTools: [],
          },
          assertedByUser: true,
          provenance: { source: 'user-override' },
        },
      ],
    },
    results: [
      {
        taskId: 'checkout',
        agentId: 'agent',
        trial: 1,
        status: 'failed',
        error: 'trial execution failed',
        output: [{ type: 'text', text: 'Could not buy' }],
        trace: {
          id: 'trace-1',
          suiteId: 'suite-1',
          taskId: 'checkout',
          agentId: 'agent',
          trial: 1,
          startedAt: 10,
          finishedAt: 20,
          events: [
            {
              id: 'event-1',
              traceId: 'trace-1',
              sequence: 1,
              type: 'run.started',
              timestamp: 10,
              agentId: 'agent',
            },
            {
              id: 'event-2',
              traceId: 'trace-1',
              sequence: 2,
              type: 'model.completed',
              timestamp: 15,
              providerId: 'provider',
              model: 'model',
              output: [{ type: 'text', text: 'Could not buy' }],
              durationMs: 5,
              usage: { inputTokens: 12, outputTokens: 4 },
              costUSD: 0.003,
            },
            {
              id: 'event-unknown',
              traceId: 'trace-1',
              sequence: 3,
              type: 'model.completed',
              timestamp: 16,
              providerId: 'provider',
              model: 'unknown-cost-model',
              output: [],
              durationMs: 1,
            },
            {
              id: 'event-3',
              traceId: 'trace-1',
              sequence: 4,
              type: 'run.completed',
              timestamp: 20,
              status: 'failed',
            },
          ],
        },
        scores: [
          {
            graderId: 'judge',
            kind: 'judge',
            passed: false,
            detail: 'insufficient judge quorum',
            minimumQuorum: 2,
            judgeVotes: [
              {
                providerId: 'p1',
                model: 'judge-1',
                label: 'fail',
                score: 0.1,
                reasoning: 'incorrect outcome',
              },
            ],
            judgeFailures: [{ providerId: 'p2', model: 'judge-2', error: 'timeout' }],
            resourceCalls: { attempted: 2, usageKnown: 0, costKnown: 0 },
          },
        ],
      },
    ],
    summary: {
      total: 1,
      passed: 0,
      failed: 1,
      errors: 0,
      cancelled: 0,
      passRate: 0,
      confidence95: { low: 0, high: 0.79 },
      passAtK: { 1: 0 },
      passToK: { 1: 0 },
      reliabilityByCase: [
        {
          agentId: 'agent',
          taskId: 'checkout',
          total: 1,
          passed: 0,
          passRate: 0,
          confidence95: { low: 0, high: 0.79 },
          passAtK: { 1: 0 },
          passToK: { 1: 0 },
        },
      ],
    },
  },
};

describe('ReportView agent reports', () => {
  beforeEach(() => {
    useEvalRunStore.setState({ runs: {} });
    useAiLabStore.setState({ runReports: { [REPORT.id]: REPORT } });
    useAiLabUiStore.setState({ reportRunId: REPORT.id, reportDrillCaseId: null });
  });

  it('renders the full persisted agent result and offers JSON export', () => {
    render(<ReportView />);

    expect(screen.getByText('95% confidence')).toBeInTheDocument();
    expect(screen.getByText('Buy one book')).toBeInTheDocument();
    expect(screen.getByText('Order confirmed')).toBeInTheDocument();
    expect(screen.getByText(/insufficient judge quorum/i)).toBeInTheDocument();
    expect(screen.getByText(/judge-2.*timeout/i)).toBeInTheDocument();
    expect(screen.getByText(/12 in · 4 out/i)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.003000/)).toBeInTheDocument();
    expect(screen.getAllByText(/partially known/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/trial execution failed/i)).toBeInTheDocument();
    expect(screen.getByText(/incorrect outcome/i)).toBeInTheDocument();
    expect(screen.getByText(/1 total.*1 failed.*0 errors.*0 cancelled/i)).toBeInTheDocument();
    expect(screen.getAllByText(/pass@k/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/model\.completed/)).toBeInTheDocument();
    expect(screen.getByText(/user asserted.*tools enabled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'JSON' })).toBeInTheDocument();
  });

  it('labels usage and cost unknown instead of displaying zero', () => {
    const unknown = structuredClone(REPORT);
    if (unknown.kind !== 'agent-suite') throw new Error('expected agent report');
    for (const event of unknown.payload.results[0]!.trace.events) {
      if (event.type === 'model.completed') {
        delete event.usage;
        delete event.costUSD;
      }
    }
    useAiLabStore.setState({ runReports: { [unknown.id]: unknown } });

    render(<ReportView />);

    expect(screen.getAllByText('unknown')).toHaveLength(2);
    expect(screen.queryByText('$0.000000')).not.toBeInTheDocument();
  });

  it('counts failed and calibration judge attempts as unknown resource coverage', () => {
    const report = structuredClone(REPORT);
    if (report.kind !== 'agent-suite') throw new Error('expected agent report');
    const score = report.payload.results[0]!.scores[0]!;
    score.usage = { inputTokens: 9, outputTokens: 3 };
    score.costUSD = 0.001;
    score.resourceCalls = { attempted: 4, usageKnown: 2, costKnown: 1 };
    useAiLabStore.setState({ runReports: { [report.id]: report } });

    render(<ReportView />);

    expect(screen.getByText(/21 in · 7 out · partially known/i)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.004000 · partially known/i)).toBeInTheDocument();
  });

  it('renders, drills into, compares, and exports a feature-rich eval report', () => {
    const previous: EvalRun = {
      id: 'eval-prev',
      evalConfigId: 'eval-config',
      configName: 'Regression / suite',
      datasetId: 'dataset',
      datasetName: 'Cases',
      startedAt: 1,
      finishedAt: 2,
      status: 'done',
      totalCells: 2,
      cells: [
        {
          caseId: 'case-a',
          modelRef: { providerConfigId: 'p', model: 'alpha' },
          output: 'old',
          ok: true,
          latencyMs: 20,
          cost: 0,
          scores: [],
          passed: false,
        },
        {
          caseId: 'case-a',
          modelRef: { providerConfigId: 'p', model: 'beta' },
          output: 'old',
          ok: true,
          latencyMs: 25,
          cost: 0,
          scores: [],
          passed: true,
        },
      ],
    };
    const current: EvalRun = {
      ...previous,
      id: 'eval-current',
      startedAt: 10,
      finishedAt: 20,
      totalCells: 4,
      modelLabels: { 'p:alpha': 'Alpha label' },
      cells: [
        {
          caseId: 'case-a',
          modelRef: { providerConfigId: 'p', model: 'alpha' },
          output: 'answer',
          ok: true,
          latencyMs: 10.4,
          cost: 0.002,
          scores: [
            {
              scorerId: 'judge',
              kind: 'judge',
              passed: true,
              score: 0.9,
              detail: 'strong',
              variance: 0.02,
              perCriterion: [
                { name: 'correctness', score: 1, pass: true, reasoning: 'yes' },
                { name: 'style', score: 0, pass: false, reasoning: 'no' },
              ],
            },
          ],
          passed: true,
          executed: { status: 200, latencyMs: 9.6, bodyExcerpt: 'answer', ok: true },
        },
        {
          caseId: 'case-a',
          modelRef: { providerConfigId: 'p', model: 'beta' },
          output: '',
          error: 'model failed',
          ok: false,
          latencyMs: 40.6,
          cost: null,
          scores: [{ scorerId: 'exact', kind: 'exact-match', passed: false }],
          passed: false,
        },
        {
          caseId: 'case-b',
          modelRef: { providerConfigId: 'p', model: 'alpha' },
          output: '',
          ok: true,
          latencyMs: 15,
          cost: 0,
          scores: [],
          passed: false,
          notEvaluated: true,
        },
        {
          caseId: 'case-b',
          modelRef: { providerConfigId: 'p', model: 'gamma' },
          output: 'free output',
          ok: true,
          latencyMs: 12,
          cost: 0,
          scores: [],
          passed: true,
        },
      ],
    };
    useEvalRunStore.setState({ runs: { [previous.id]: previous, [current.id]: current } });
    useAiLabStore.setState({
      runReports: {},
      datasets: {
        dataset: {
          id: 'dataset',
          name: 'Cases',
          createdAt: 0,
          updatedAt: 0,
          cases: [
            { id: 'case-a', vars: { prompt: 'A very descriptive prompt', extra: 'value' } },
            { id: 'case-b', vars: {} },
          ],
        },
      },
    });
    useAiLabUiStore.setState({ reportRunId: current.id, reportDrillCaseId: null });

    render(<ReportView />);

    expect(screen.getAllByText('Alpha label').length).toBeGreaterThan(0);
    expect(screen.getByText(/Avg variance/i)).toBeInTheDocument();
    expect(screen.getByText(/Δ compares against the previous run/i)).toBeInTheDocument();
    expect(screen.getAllByText(/100% \(1\/1\)/i).length).toBeGreaterThan(0);
    expect(screen.getByText('free')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText(/Case 1 — prompt=A very descriptive/));
    expect(screen.getByText('model failed')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 200 · 10ms/i)).toBeInTheDocument();
    expect(screen.getByText('strong')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear case selection' }));

    fireEvent.click(screen.getByTitle('Export CSV'));
    fireEvent.click(screen.getByTitle('Export JSON'));
    fireEvent.click(screen.getByTitle('Export Markdown'));
    expect(downloadBlob).toHaveBeenCalledTimes(3);
    expect(downloadBlob.mock.calls.map((call) => call[1])).toEqual([
      'Regression_suite.csv',
      'Regression_suite.json',
      'Regression_suite.md',
    ]);
  });

  it('renders the empty report action when no run exists', () => {
    useEvalRunStore.setState({ runs: {} });
    useAiLabStore.setState({ runReports: {} });
    useAiLabUiStore.setState({ reportRunId: null, reportDrillCaseId: null });

    render(<ReportView />);

    fireEvent.click(screen.getByRole('button', { name: 'Configure an eval' }));
    expect(useAiLabUiStore.getState().tab).toBe('evals');
  });
});
