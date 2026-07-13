import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReportView } from '../ReportView';
import type { AiLabReportEnvelope } from '../../run-engine/reportEnvelope';
import { useAiLabStore } from '../../store/useAiLabStore';
import { useAiLabUiStore } from '../../store/useAiLabUiStore';
import { useEvalRunStore } from '../../store/useEvalRunStore';

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
});
