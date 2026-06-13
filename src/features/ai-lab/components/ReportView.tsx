import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, BarChart3, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Floater, Stat } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { percentile } from '@/lib/shared/loadStats';
import { useEvalRunStore } from '../store/useEvalRunStore';
import { EmptyState } from './EmptyState';
import { StatusChip } from './StatusChip';
import type { EvalCellResult, EvalRun } from '../types';

interface ModelStats {
  label: string;
  total: number;
  passed: number;
  passRate: number;
  p50: number;
  p95: number;
  cost: number | null;
}

function statsByModel(run: EvalRun): ModelStats[] {
  const groups = new Map<string, EvalCellResult[]>();
  for (const cell of run.cells) {
    const key = `${cell.modelRef.providerConfigId}:${cell.modelRef.model}`;
    const arr = groups.get(key) ?? [];
    arr.push(cell);
    groups.set(key, arr);
  }
  return [...groups.entries()].map(([key, cells]) => {
    const latencies = cells.map((c) => c.latencyMs);
    const passed = cells.filter((c) => c.passed).length;
    const costs = cells.map((c) => c.cost);
    const cost = costs.some((c) => c === null)
      ? null
      : costs.reduce<number>((a, c) => a + (c ?? 0), 0);
    return {
      label: key.split(':').slice(1).join(':') || key,
      total: cells.length,
      passed,
      passRate: cells.length ? passed / cells.length : 0,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      cost,
    };
  });
}

interface JudgeStats {
  /** Number of judge score instances across the run's cells. */
  judged: number;
  /** Mean variance of judge scores across self-consistency samples (null if none sampled). */
  avgVariance: number | null;
  criteria: { name: string; passed: number; total: number }[];
}

/** Aggregate per-criterion pass rates + judge stability across a run's judge scores. */
export function judgeStats(run: EvalRun): JudgeStats {
  const byCriterion = new Map<string, { passed: number; total: number }>();
  let varSum = 0;
  let varCount = 0;
  let judged = 0;
  for (const cell of run.cells) {
    for (const s of cell.scores) {
      if (s.kind !== 'judge') continue;
      judged++;
      if (typeof s.variance === 'number') {
        varSum += s.variance;
        varCount++;
      }
      for (const pc of s.perCriterion ?? []) {
        const e = byCriterion.get(pc.name) ?? { passed: 0, total: 0 };
        e.total++;
        if (pc.pass) e.passed++;
        byCriterion.set(pc.name, e);
      }
    }
  }
  return {
    judged,
    avgVariance: varCount ? varSum / varCount : null,
    criteria: [...byCriterion.entries()].map(([name, v]) => ({ name, ...v })),
  };
}

export function ReportView() {
  const runs = useEvalRunStore((s) => s.runs);
  const deleteRun = useEvalRunStore((s) => s.deleteRun);
  const sorted = useMemo(
    () => Object.values(runs).sort((a, b) => b.startedAt - a.startedAt),
    [runs]
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = activeId ? runs[activeId] : sorted[0];

  // Previous run of the SAME eval config — enables regression compare.
  const previous = useMemo(() => {
    if (!active) return undefined;
    return sorted.find(
      (r) => r.evalConfigId === active.evalConfigId && r.startedAt < active.startedAt
    );
  }, [active, sorted]);

  const current = active ? statsByModel(active) : [];
  const prevStats = previous ? statsByModel(previous) : [];
  const judge = useMemo(() => (active ? judgeStats(active) : null), [active]);

  if (sorted.length === 0) {
    return (
      <EmptyState
        fill
        icon={BarChart3}
        message="No runs yet. Configure an eval and run it first."
      />
    );
  }

  return (
    <div className="flex h-full">
      {/* Run list — master pane. */}
      <div className="flex w-[280px] shrink-0 flex-col gap-2 overflow-auto border-r border-sp-line p-3">
        {sorted.map((r) => (
          <button
            key={r.id}
            onClick={() => setActiveId(r.id)}
            className={cn(
              'w-full rounded-sp-btn border px-3 py-2.5 text-left transition-colors',
              active?.id === r.id
                ? 'border-sp-accent bg-[var(--sp-accent-glow-15)]'
                : 'border-sp-line hover:bg-sp-hover'
            )}
          >
            <div className="truncate text-sp-13 text-sp-text">{r.configName}</div>
            <div className="mt-1 flex items-center justify-between">
              <StatusChip state={r.status} />
              <span className="text-sp-11 text-sp-muted tabular-nums">
                {r.cells.length}/{r.totalCells}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Report — detail pane, fills the window. */}
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {active ? (
          <Floater radius="panel" elevation="float" className="space-y-4 bg-sp-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="truncate text-sp-13 font-semibold text-sp-text">
                {active.configName}
              </h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete run"
                title="Delete run"
                onClick={() => {
                  deleteRun(active.id);
                  setActiveId(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
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
                  {current
                    .slice()
                    .sort((a, b) => b.passRate - a.passRate)
                    .map((m) => {
                      const prev = prevStats.find((p) => p.label === m.label);
                      const delta = prev ? m.passRate - prev.passRate : null;
                      return (
                        <tr key={m.label} className="border-b border-sp-line">
                          <td className="py-2 pr-3 font-medium">{m.label}</td>
                          <td className="py-2 pr-3 tabular-nums">
                            {(m.passRate * 100).toFixed(0)}% ({m.passed}/{m.total})
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
                          <td className="py-2 pr-3 tabular-nums">{Math.round(m.p50)}ms</td>
                          <td className="py-2 pr-3 tabular-nums">{Math.round(m.p95)}ms</td>
                          <td className="py-2 pr-3 tabular-nums">
                            {m.cost === null
                              ? '—'
                              : m.cost === 0
                                ? 'free'
                                : `$${m.cost.toFixed(4)}`}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            {judge && judge.judged > 0 && judge.criteria.length > 0 && (
              <div className="space-y-2 border-t border-sp-line pt-3">
                <h3 className="sp-label">Judge criteria</h3>
                <div className="flex flex-wrap gap-x-6 gap-y-3">
                  {judge.criteria.map((c) => {
                    const rate = c.total ? c.passed / c.total : 0;
                    return (
                      <Stat
                        key={c.name}
                        label={c.name}
                        value={
                          <span
                            className={
                              rate >= 1 ? 'text-emerald-500' : rate === 0 ? 'text-destructive' : ''
                            }
                          >
                            {(rate * 100).toFixed(0)}%{' '}
                            <span className="text-sp-muted">
                              ({c.passed}/{c.total})
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
            {previous && (
              <p className="text-sp-11 text-sp-muted">
                Δ compares against the previous run of this eval.
              </p>
            )}
          </Floater>
        ) : (
          <EmptyState fill message="Select a run to view its report." />
        )}
      </div>
    </div>
  );
}
