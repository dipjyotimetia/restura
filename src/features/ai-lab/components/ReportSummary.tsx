import { ArrowDown, ArrowUp, Download, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Floater, Stat } from '@/components/ui/spatial';
import { formatRelativeTime } from '@/lib/shared/console-format';
import { percentile } from '@/lib/shared/loadStats';
import { cn } from '@/lib/shared/utils';
import { modelKey, parseModelKey } from '../lib/modelOptions';
import type { EvalCellResult, EvalRun } from '../types';

export interface ModelStats {
  /** `providerConfigId:model` key. */
  key: string;
  label: string;
  total: number;
  passed: number;
  passRate: number;
  p50: number;
  p95: number;
  cost: number | null;
}

/** Friendly label for a model key: run-captured label > raw model id. */
export function labelForModel(run: EvalRun, key: string): string {
  return run.modelLabels?.[key] ?? (parseModelKey(key).model || key);
}

export function statsByModel(run: EvalRun): ModelStats[] {
  const groups = new Map<string, EvalCellResult[]>();
  for (const cell of run.cells) {
    const key = modelKey(cell.modelRef);
    const cells = groups.get(key) ?? [];
    cells.push(cell);
    groups.set(key, cells);
  }
  return [...groups.entries()].map(([key, cells]) => {
    const latencies = cells.map((cell) => cell.latencyMs);
    // notEvaluated cells (no scorers) are neither pass nor fail — exclude them
    // from the pass-rate denominator so a zero-scorer run doesn't read as 0%.
    const evaluated = cells.filter((cell) => !cell.notEvaluated);
    const passed = evaluated.filter((cell) => cell.passed).length;
    const costs = cells.map((cell) => cell.cost);
    const cost = costs.some((value) => value === null)
      ? null
      : costs.reduce<number>((total, value) => total + (value ?? 0), 0);
    return {
      key,
      label: labelForModel(run, key),
      total: evaluated.length,
      passed,
      passRate: evaluated.length ? passed / evaluated.length : 0,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      cost,
    };
  });
}

export interface JudgeStats {
  /** Number of judge score instances across the run's cells. */
  judged: number;
  /** Mean variance of judge scores across self-consistency samples (null if none sampled). */
  avgVariance: number | null;
  criteria: { name: string; passed: number; total: number }[];
}

/** Aggregate per-criterion pass rates + judge stability across a run's judge scores. */
export function judgeStats(run: EvalRun): JudgeStats {
  const byCriterion = new Map<string, { passed: number; total: number }>();
  let varianceSum = 0;
  let varianceCount = 0;
  let judged = 0;
  for (const cell of run.cells) {
    for (const score of cell.scores) {
      if (score.kind !== 'judge') continue;
      judged++;
      if (typeof score.variance === 'number') {
        varianceSum += score.variance;
        varianceCount++;
      }
      for (const criterion of score.perCriterion ?? []) {
        const current = byCriterion.get(criterion.name) ?? { passed: 0, total: 0 };
        current.total++;
        if (criterion.pass) current.passed++;
        byCriterion.set(criterion.name, current);
      }
    }
  }
  return {
    judged,
    avgVariance: varianceCount ? varianceSum / varianceCount : null,
    criteria: [...byCriterion.entries()].map(([name, stats]) => ({ name, ...stats })),
  };
}

interface ReportSummaryProps {
  run: EvalRun;
  stats: ModelStats[];
  previousStatsByKey: Map<string, ModelStats>;
  judge: JudgeStats;
  hasPreviousRun: boolean;
  onExport: (format: 'csv' | 'json' | 'md') => void;
  onDelete: () => void;
  children?: ReactNode;
}

/** Eval report header, model statistics, judge summary, and export controls. */
export function ReportSummary({
  run,
  stats,
  previousStatsByKey,
  judge,
  hasPreviousRun,
  onExport,
  onDelete,
  children,
}: ReportSummaryProps) {
  return (
    <Floater radius="panel" elevation="float" className="space-y-4 bg-sp-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sp-13 font-semibold text-sp-text">{run.configName}</h2>
          <p className="truncate text-sp-11 text-sp-muted">
            {formatRelativeTime(run.startedAt)}
            {run.datasetName ? ` · ${run.datasetName}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => onExport('csv')} title="Export CSV">
            <Download className="mr-1 h-3.5 w-3.5" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => onExport('json')} title="Export JSON">
            JSON
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onExport('md')}
            title="Export Markdown"
          >
            MD
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete run"
            title="Delete run"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sp-12">
          <thead>
            <tr className="border-b border-sp-line text-left text-sp-11 uppercase tracking-wide text-sp-muted">
              <th className="py-2 pr-3 font-medium">Model</th>
              <th className="py-2 pr-3 font-medium">Pass rate</th>
              <th className="py-2 pr-3 font-medium">Δ vs prev</th>
              <th className="py-2 pr-3 font-medium">p50</th>
              <th className="py-2 pr-3 font-medium">p95</th>
              <th className="py-2 pr-3 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="text-sp-text">
            {stats.map((model) => {
              const previous = previousStatsByKey.get(model.key);
              const delta = previous ? model.passRate - previous.passRate : null;
              return (
                <tr key={model.key} className="border-b border-sp-line">
                  <td className="py-2 pr-3 font-medium">{model.label}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {(model.passRate * 100).toFixed(0)}% ({model.passed}/{model.total})
                  </td>
                  <td className="py-2 pr-3">
                    {delta === null || delta === 0 ? (
                      <span className="text-sp-muted">—</span>
                    ) : (
                      <span
                        className={cn(
                          'inline-flex items-center gap-0.5 tabular-nums',
                          delta > 0 ? 'text-emerald-500' : 'text-destructive'
                        )}
                      >
                        {delta > 0 ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )}
                        {Math.abs(delta * 100).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{Math.round(model.p50)}ms</td>
                  <td className="py-2 pr-3 tabular-nums">{Math.round(model.p95)}ms</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {model.cost === null
                      ? '—'
                      : model.cost === 0
                        ? 'free'
                        : `$${model.cost.toFixed(4)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {judge.judged > 0 && judge.criteria.length > 0 && (
        <div className="space-y-2 border-t border-sp-line pt-3">
          <h3 className="sp-label">Judge criteria</h3>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {judge.criteria.map((criterion) => {
              const rate = criterion.total ? criterion.passed / criterion.total : 0;
              return (
                <Stat
                  key={criterion.name}
                  label={criterion.name}
                  value={
                    <span
                      className={
                        rate >= 1 ? 'text-emerald-500' : rate === 0 ? 'text-destructive' : ''
                      }
                    >
                      {(rate * 100).toFixed(0)}%{' '}
                      <span className="text-sp-muted">
                        ({criterion.passed}/{criterion.total})
                      </span>
                    </span>
                  }
                />
              );
            })}
            {judge.avgVariance !== null && (
              <Stat
                label="Avg variance"
                value={judge.avgVariance.toFixed(3)}
                title="Mean variance of judge scores across self-consistency samples (lower = more stable)"
              />
            )}
          </div>
        </div>
      )}

      {children}
      {hasPreviousRun && (
        <p className="text-sp-11 text-sp-muted">
          Δ compares against the previous run of this eval.
        </p>
      )}
    </Floater>
  );
}
