import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AiLabReportEnvelope } from '../../run-engine/reportEnvelope';
import type { Dataset, EvalRun } from '../../types';
import { ReportMatrix } from '../ReportMatrix';
import { ReportRunList } from '../ReportRunList';
import {
  judgeStats,
  labelForModel,
  type ModelStats,
  ReportSummary,
  statsByModel,
} from '../ReportSummary';

const RUN: EvalRun = {
  id: 'run-1',
  evalConfigId: 'eval-1',
  configName: 'Regression suite',
  datasetId: 'dataset-1',
  datasetName: 'Checkout cases',
  modelLabels: { 'provider-a:model-a': 'Alpha' },
  startedAt: 1_700_000_000_000,
  status: 'done',
  totalCells: 4,
  cells: [
    {
      caseId: 'case-a',
      modelRef: { providerConfigId: 'provider-a', model: 'model-a' },
      output: 'accepted',
      ok: true,
      latencyMs: 24.2,
      cost: 0.12,
      passed: true,
      scores: [
        {
          scorerId: 'judge-1',
          kind: 'judge',
          passed: true,
          score: 1,
          detail: 'complete',
          variance: 0.04,
          perCriterion: [
            { name: 'Correctness', score: 1, pass: true, reasoning: 'yes' },
            { name: 'Style', score: 0, pass: false, reasoning: 'no' },
          ],
        },
      ],
      executed: { status: 201, latencyMs: 12.4, bodyExcerpt: 'created', ok: true },
    },
    {
      caseId: 'case-a',
      modelRef: { providerConfigId: 'provider-b', model: 'model-b' },
      output: '',
      ok: true,
      latencyMs: 36.8,
      cost: null,
      passed: false,
      scores: [{ scorerId: 'contains-1', kind: 'contains', passed: false }],
    },
    {
      caseId: 'case-b',
      modelRef: { providerConfigId: 'provider-a', model: 'model-a' },
      output: 'not scored',
      ok: true,
      latencyMs: 42,
      cost: 0,
      passed: false,
      notEvaluated: true,
      scores: [],
    },
  ],
};

const DATASET: Dataset = {
  id: 'dataset-1',
  name: 'Checkout cases',
  createdAt: 0,
  updatedAt: 0,
  cases: [{ id: 'case-a', vars: { region: 'au', role: 'buyer' } }],
};

const STATS: ModelStats[] = [
  {
    key: 'provider-a:model-a',
    label: 'Alpha',
    total: 2,
    passed: 2,
    passRate: 1,
    p50: 10.1,
    p95: 20.9,
    cost: null,
  },
  {
    key: 'provider-b:model-b',
    label: 'Beta',
    total: 2,
    passed: 1,
    passRate: 0.5,
    p50: 11.1,
    p95: 21.9,
    cost: 0,
  },
  {
    key: 'provider-c:model-c',
    label: 'Gamma',
    total: 2,
    passed: 1,
    passRate: 0.5,
    p50: 12.1,
    p95: 22.9,
    cost: 1.23456,
  },
  {
    key: 'provider-d:model-d',
    label: 'Delta',
    total: 0,
    passed: 0,
    passRate: 0,
    p50: 13.1,
    p95: 23.9,
    cost: 0.5,
  },
];

describe('report components', () => {
  it('calculates model and judge aggregates with recorded labels and incomplete score data', () => {
    expect(labelForModel(RUN, 'provider-a:model-a')).toBe('Alpha');
    expect(labelForModel(RUN, 'provider-b:model-b')).toBe('model-b');
    expect(labelForModel(RUN, 'legacy-key')).toBe('legacy-key');

    const runWithOnlyUnevaluatedModel: EvalRun = {
      ...RUN,
      cells: [
        ...RUN.cells,
        {
          caseId: 'case-c',
          modelRef: { providerConfigId: 'provider-c', model: 'model-c' },
          output: 'not evaluated',
          ok: true,
          latencyMs: 5,
          cost: 0,
          passed: false,
          notEvaluated: true,
          scores: [{ scorerId: 'judge-2', kind: 'judge', passed: false }],
        },
      ],
    };

    expect(statsByModel(runWithOnlyUnevaluatedModel)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'provider-a:model-a', total: 1, passed: 1, cost: 0.12 }),
        expect.objectContaining({ key: 'provider-b:model-b', total: 1, passed: 0, cost: null }),
        expect.objectContaining({ key: 'provider-c:model-c', total: 0, passed: 0, passRate: 0 }),
      ])
    );
    expect(judgeStats(runWithOnlyUnevaluatedModel)).toEqual({
      judged: 2,
      avgVariance: 0.04,
      criteria: [
        { name: 'Correctness', passed: 1, total: 1 },
        { name: 'Style', passed: 0, total: 1 },
      ],
    });
  });

  it('renders report actions, deltas, costs, judge criteria, and the previous-run explanation', () => {
    const onExport = vi.fn();
    const onDelete = vi.fn();
    render(
      <ReportSummary
        run={RUN}
        stats={STATS}
        previousStatsByKey={
          new Map([
            ['provider-a:model-a', { ...STATS[0], passRate: 0.5 }],
            ['provider-b:model-b', { ...STATS[1], passRate: 1 }],
            ['provider-c:model-c', { ...STATS[2] }],
          ])
        }
        judge={{
          judged: 2,
          avgVariance: 0.125,
          criteria: [
            { name: 'Correctness', passed: 1, total: 1 },
            { name: 'Style', passed: 0, total: 1 },
            { name: 'Completeness', passed: 1, total: 2 },
          ],
        }}
        hasPreviousRun
        onExport={onExport}
        onDelete={onDelete}
      >
        <p>Case matrix</p>
      </ReportSummary>
    );

    fireEvent.click(screen.getByRole('button', { name: /csv/i }));
    fireEvent.click(screen.getByRole('button', { name: /json/i }));
    fireEvent.click(screen.getByRole('button', { name: 'MD' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete run' }));

    expect(onExport).toHaveBeenCalledWith('csv');
    expect(onExport).toHaveBeenCalledWith('json');
    expect(onExport).toHaveBeenCalledWith('md');
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.getByText('$1.2346')).toBeInTheDocument();
    expect(screen.getByText('free')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(1);
    expect(screen.getByText('Avg variance')).toBeInTheDocument();
    expect(screen.getByText('Case matrix')).toBeInTheDocument();
    expect(screen.getByText(/Δ compares against the previous run/i)).toBeInTheDocument();
  });

  it('shows the case matrix fallback labels, result details, and selection controls', () => {
    const onDrillCaseChange = vi.fn();
    render(
      <ReportMatrix
        run={RUN}
        dataset={DATASET}
        stats={STATS.slice(0, 2)}
        drillCaseId="case-a"
        onDrillCaseChange={onDrillCaseChange}
      />
    );

    expect(screen.getAllByText(/Case 1 — region=au/)).toHaveLength(2);
    expect(screen.getByText(/Case 2 \(case-b\)/)).toBeInTheDocument();
    expect(screen.getByText('HTTP 201 · 12ms')).toBeInTheDocument();
    expect(screen.getByText('accepted')).toBeInTheDocument();
    expect(screen.getByText('(empty)')).toBeInTheDocument();
    expect(screen.getByText('complete')).toBeInTheDocument();
    fireEvent.click(screen.getAllByText(/Case 1 — region=au/)[0]);
    fireEvent.click(screen.getByText(/Case 2 \(case-b\)/));
    fireEvent.click(screen.getByRole('button', { name: 'Clear case selection' }));
    expect(onDrillCaseChange).toHaveBeenNthCalledWith(1, null);
    expect(onDrillCaseChange).toHaveBeenNthCalledWith(2, 'case-b');
    expect(onDrillCaseChange).toHaveBeenNthCalledWith(3, null);
  });

  it('does not render an empty matrix and distinguishes selected eval and agent-suite reports', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ReportMatrix
        run={{ ...RUN, cells: [] }}
        stats={STATS}
        drillCaseId={null}
        onDrillCaseChange={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();

    render(
      <ReportRunList
        selectedId="eval-report"
        onSelect={onSelect}
        reports={[
          {
            id: 'eval-report',
            kind: 'eval',
            name: 'Eval report',
            startedAt: RUN.startedAt,
            finishedAt: RUN.startedAt,
            status: 'passed',
            payload: RUN,
          },
          {
            id: 'agent-report',
            kind: 'agent-suite',
            name: 'Agent report',
            startedAt: RUN.startedAt,
            finishedAt: RUN.startedAt,
            status: 'failed',
            payload: { summary: { passed: 1, total: 2 } },
            suite: {},
          } as unknown as AiLabReportEnvelope,
          {
            id: 'eval-without-dataset',
            kind: 'eval',
            name: 'Legacy eval report',
            startedAt: RUN.startedAt,
            finishedAt: RUN.startedAt,
            status: 'passed',
            payload: { ...RUN, datasetName: undefined },
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /agent report/i }));
    expect(screen.getAllByText('3/4')).toHaveLength(2);
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText(/Agent suite/)).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith('agent-report');
  });

  it('omits optional report metadata and uses neutral styling for zero-rate criteria', () => {
    render(
      <ReportSummary
        run={{ ...RUN, datasetName: undefined }}
        stats={[]}
        previousStatsByKey={new Map()}
        judge={{
          judged: 1,
          avgVariance: null,
          criteria: [{ name: 'No samples', passed: 0, total: 0 }],
        }}
        hasPreviousRun={false}
        onExport={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.queryByText('Checkout cases')).not.toBeInTheDocument();
    expect(screen.getByText('No samples')).toBeInTheDocument();
    expect(screen.queryByText('Avg variance')).not.toBeInTheDocument();
    expect(screen.queryByText(/Δ compares against the previous run/i)).not.toBeInTheDocument();
  });
});
