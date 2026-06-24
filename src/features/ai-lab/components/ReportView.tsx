import { ArrowDown, ArrowUp, BarChart3, Download, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { runToCsv, runToJson, runToMarkdown } from '../lib/reportExport';
import { useEvalRunStore } from '../store/useEvalRunStore';
import type { EvalCellResult, EvalRun } from '../types';
import { EmptyState } from './EmptyState';
import { StatusChip } from './StatusChip';
import { Button } from '@/components/ui/button';
import { Floater, Stat } from '@/components/ui/spatial';
import { downloadBlob } from '@/lib/shared/file-utils';
import { percentile } from '@/lib/shared/loadStats';
import { cn } from '@/lib/shared/utils';

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
    // notEvaluated cells (no scorers) are neither pass nor fail — exclude them
    // from the pass-rate denominator so a zero-scorer run doesn't read as 0%.
    const evaluated = cells.filter((c) => !c.notEvaluated);
    const passed = evaluated.filter((c) => c.passed).length;
    const costs = cells.map((c) => c.cost);
    const cost = costs.some((c) => c === null)
      ? null
      : costs.reduce<number>((a, c) => a + (c ?? 0), 0);
    return {
      label: key.split(':').slice(1).join(':') || key,
      total: evaluated.length,
      passed,
      passRate: evaluated.length ? passed / evaluated.length : 0,
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
  const [drillCaseId, setDrillCaseId] = useState<string | null>(null);

  // Distinct case ids in the active run, in first-seen order.
  const caseIds = useMemo(() => {
    if (!active) return [];
    const seen: string[] = [];
    const set = new Set<string>();
    for (const c of active.cells) {
      if (!set.has(c.caseId)) {
        set.add(c.caseId);
        seen.push(c.caseId);
      }
    }
    return seen;
  }, [active]);

  const drillCells = useMemo(
    () => (active && drillCaseId ? active.cells.filter((c) => c.caseId === drillCaseId) : []),
    [active, drillCaseId]
  );

  const exportRun = (format: 'csv' | 'json' | 'md') => {
    if (!active) return;
    const safe = active.configName.replace(/[^a-z0-9-_]+/gi, '_') || 'run';
    if (format === 'csv') downloadBlob(runToCsv(active), `${safe}.csv`, 'text/csv');
    else if (format === 'json') downloadBlob(runToJson(active), `${safe}.json`, 'application/json');
    else downloadBlob(runToMarkdown(active), `${safe}.md`, 'text/markdown');
  };

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
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => exportRun('csv')}
                  title="Export CSV"
                >
                  <Download className="mr-1 h-3.5 w-3.5" /> CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => exportRun('json')}
                  title="Export JSON"
                >
                  JSON
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => exportRun('md')}
                  title="Export Markdown"
                >
                  MD
                </Button>
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
            {caseIds.length > 0 && (
              <div className="space-y-2 border-t border-sp-line pt-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="sp-label">Per-case drill-down</h3>
                  <select
                    value={drillCaseId ?? ''}
                    onChange={(e) => setDrillCaseId(e.target.value || null)}
                    className="rounded-sp-btn border border-sp-line bg-sp-surface px-2 py-1 text-sp-12 text-sp-text"
                  >
                    <option value="">Select a case…</option>
                    {caseIds.map((id, i) => (
                      <option key={id} value={id}>
                        Case {i + 1} ({id.slice(0, 8)})
                      </option>
                    ))}
                  </select>
                </div>
                {drillCells.length > 0 && (
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                    {drillCells.map((cell) => (
                      <Floater
                        key={`${cell.caseId}:${cell.modelRef.providerConfigId}:${cell.modelRef.model}`}
                        radius="panel"
                        elevation="inset"
                        className="flex flex-col gap-2 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sp-12 font-medium text-sp-text">
                            {cell.modelRef.model}
                          </span>
                          <span
                            className={cn(
                              'shrink-0 rounded px-1.5 py-0.5 text-sp-11',
                              cell.notEvaluated
                                ? 'bg-sp-hover text-sp-muted'
                                : cell.passed
                                  ? 'bg-emerald-500/15 text-emerald-500'
                                  : 'bg-destructive/15 text-destructive'
                            )}
                          >
                            {cell.notEvaluated ? 'n/a' : cell.passed ? 'pass' : 'fail'}
                          </span>
                        </div>
                        {cell.executed && (
                          <div className="text-sp-11 text-sp-muted">
                            HTTP {cell.executed.status} · {Math.round(cell.executed.latencyMs)}ms
                          </div>
                        )}
                        <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-sp-bg p-2 text-sp-11 text-sp-text">
                          {cell.error ? (
                            <span className="text-destructive">{cell.error}</span>
                          ) : (
                            cell.output || <span className="text-sp-muted">(empty)</span>
                          )}
                        </div>
                        {cell.scores.length > 0 && (
                          <div className="space-y-1 border-t border-sp-line pt-1.5">
                            {cell.scores.map((s, i) => (
                              <div
                                key={i}
                                className="flex items-start justify-between gap-2 text-sp-11"
                              >
                                <span className="text-sp-muted">{s.kind}</span>
                                <span
                                  className={cn(
                                    'text-right',
                                    s.passed ? 'text-emerald-500' : 'text-destructive'
                                  )}
                                >
                                  {s.passed ? 'pass' : 'fail'}
                                  {s.score !== undefined ? ` (${s.score.toFixed(2)})` : ''}
                                  {s.detail ? (
                                    <span className="block text-sp-text-dim">{s.detail}</span>
                                  ) : null}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </Floater>
                    ))}
                  </div>
                )}
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
