import { ArrowDown, ArrowUp, BarChart3, Download, Trash2, X } from 'lucide-react';
import { useMemo } from 'react';
import { runToCsv, runToJson, runToMarkdown } from '../lib/reportExport';
import { useAiLabStore } from '../store/useAiLabStore';
import { useAiLabUiStore } from '../store/useAiLabUiStore';
import { useEvalRunStore } from '../store/useEvalRunStore';
import type { EvalCellResult, EvalRun } from '../types';
import { EmptyState } from './EmptyState';
import { StatusChip } from './StatusChip';
import { VerdictChip } from './VerdictChip';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import ResizableLayout from '@/components/shared/ResizableLayout';
import { Button } from '@/components/ui/button';
import { Floater, Stat } from '@/components/ui/spatial';
import { formatRelativeTime } from '@/lib/shared/console-format';
import { downloadBlob } from '@/lib/shared/file-utils';
import { percentile } from '@/lib/shared/loadStats';
import { cn } from '@/lib/shared/utils';

interface ModelStats {
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
function labelForModel(run: EvalRun, key: string): string {
  return run.modelLabels?.[key] ?? key.split(':').slice(1).join(':') ?? key;
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
  const datasets = useAiLabStore((s) => s.datasets);
  const sorted = useMemo(
    () => Object.values(runs).sort((a, b) => b.startedAt - a.startedAt),
    [runs]
  );
  // Selection lives in the UI store so "View report" in the Evals tab can hand
  // a run off to us, and so the selection survives tab switches.
  const activeId = useAiLabUiStore((s) => s.reportRunId);
  const setActiveId = useAiLabUiStore((s) => s.setReportRunId);
  const drillCaseId = useAiLabUiStore((s) => s.reportDrillCaseId);
  const setDrillCaseId = useAiLabUiStore((s) => s.setReportDrillCaseId);
  const active = (activeId ? runs[activeId] : undefined) ?? sorted[0];
  const { confirm: confirmDelete, DialogComponent: DeleteRunDialog } = useConfirmDialog({
    title: 'Delete run',
    description: active
      ? `Delete the report for "${active.configName}"? This cannot be undone.`
      : '',
    confirmText: 'Delete',
    variant: 'destructive',
  });

  // Previous run of the SAME eval config — enables regression compare.
  const previous = useMemo(() => {
    if (!active) return undefined;
    return sorted.find(
      (r) => r.evalConfigId === active.evalConfigId && r.startedAt < active.startedAt
    );
  }, [active, sorted]);

  const current = useMemo(() => (active ? statsByModel(active) : []), [active]);
  const prevStats = useMemo(() => (previous ? statsByModel(previous) : []), [previous]);
  const judge = useMemo(() => (active ? judgeStats(active) : null), [active]);

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

  // Model keys in stats order (sorted by pass rate, matching the table).
  const modelKeys = useMemo(
    () =>
      current
        .slice()
        .sort((a, b) => b.passRate - a.passRate)
        .map((m) => m.key),
    [current]
  );

  // caseId → cell lookup for the matrix.
  const cellByCaseAndModel = useMemo(() => {
    const map = new Map<string, EvalCellResult>();
    if (!active) return map;
    for (const c of active.cells) {
      map.set(`${c.caseId}|${c.modelRef.providerConfigId}:${c.modelRef.model}`, c);
    }
    return map;
  }, [active]);

  /**
   * Short human description of a case: its first var values, looked up from
   * the run's dataset. Falls back to the id prefix when the dataset (or case)
   * has since been deleted.
   */
  const caseLabel = useMemo(() => {
    const dataset = active?.datasetId ? datasets[active.datasetId] : undefined;
    return (caseId: string, index: number): string => {
      const c = dataset?.cases.find((x) => x.id === caseId);
      if (!c) return `Case ${index + 1} (${caseId.slice(0, 8)})`;
      const vars = Object.entries(c.vars)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${v.length > 20 ? `${v.slice(0, 20)}…` : v}`)
        .join(', ');
      return vars ? `Case ${index + 1} — ${vars}` : `Case ${index + 1}`;
    };
  }, [active, datasets]);

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

  const handleDeleteClick = async () => {
    if (!active) return;
    if (!(await confirmDelete())) return;
    deleteRun(active.id);
    setActiveId(null);
    setDrillCaseId(null);
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
    <>
      <ResizableLayout defaultSplit={24} minSplit={18} maxSplit={45}>
        {/* Run list — master pane. */}
        <div className="flex flex-1 flex-col gap-2 overflow-auto p-3">
          {sorted.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                setActiveId(r.id);
                setDrillCaseId(null);
              }}
              className={cn(
                'w-full rounded-sp-btn border px-3 py-2.5 text-left transition-colors',
                active?.id === r.id
                  ? 'border-sp-accent bg-[var(--sp-accent-glow-15)]'
                  : 'border-sp-line hover:bg-sp-hover'
              )}
            >
              <div className="truncate text-sp-13 text-sp-text">{r.configName}</div>
              <div className="mt-0.5 truncate text-sp-11 text-sp-muted">
                {formatRelativeTime(r.startedAt)}
                {r.datasetName ? ` · ${r.datasetName}` : ''}
              </div>
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
        <div className="flex-1 overflow-auto p-4">
          {active ? (
            <Floater radius="panel" elevation="float" className="space-y-4 bg-sp-surface p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-sp-13 font-semibold text-sp-text">
                    {active.configName}
                  </h2>
                  <p className="truncate text-sp-11 text-sp-muted">
                    {formatRelativeTime(active.startedAt)}
                    {active.datasetName ? ` · ${active.datasetName}` : ''}
                  </p>
                </div>
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
                    onClick={() => void handleDeleteClick()}
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
                        const prev = prevStats.find((p) => p.key === m.key);
                        const delta = prev ? m.passRate - prev.passRate : null;
                        return (
                          <tr key={m.key} className="border-b border-sp-line">
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
                                rate >= 1
                                  ? 'text-emerald-500'
                                  : rate === 0
                                    ? 'text-destructive'
                                    : ''
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
              {caseIds.length > 0 && modelKeys.length > 0 && (
                <div className="space-y-2 border-t border-sp-line pt-3">
                  <h3 className="sp-label">Cases × models</h3>
                  {/* Failure overview: every case × model verdict at a glance;
                      clicking a row (or chip) opens that case's drill-down. */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-sp-11">
                      <thead>
                        <tr className="text-left text-sp-muted">
                          <th className="py-1.5 pr-3 font-medium">Case</th>
                          {modelKeys.map((k) => (
                            <th
                              key={k}
                              className="max-w-[9rem] truncate px-1.5 py-1.5 text-center font-medium"
                              title={labelForModel(active, k)}
                            >
                              {labelForModel(active, k)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {caseIds.map((caseId, i) => (
                          <tr
                            key={caseId}
                            className={cn(
                              'cursor-pointer border-t border-sp-line transition-colors hover:bg-sp-hover',
                              drillCaseId === caseId && 'bg-[var(--sp-accent-glow-15)]'
                            )}
                            onClick={() => setDrillCaseId(drillCaseId === caseId ? null : caseId)}
                          >
                            <td className="max-w-[18rem] truncate py-1.5 pr-3 text-sp-text">
                              {caseLabel(caseId, i)}
                            </td>
                            {modelKeys.map((k) => {
                              const cell = cellByCaseAndModel.get(`${caseId}|${k}`);
                              return (
                                <td key={k} className="px-1.5 py-1.5 text-center">
                                  {cell ? (
                                    <VerdictChip
                                      passed={cell.passed}
                                      notEvaluated={cell.notEvaluated}
                                    />
                                  ) : (
                                    <span className="text-sp-text-dim">·</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {drillCaseId && (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <h4 className="sp-label">
                        {caseLabel(drillCaseId, Math.max(0, caseIds.indexOf(drillCaseId)))}
                      </h4>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Clear case selection"
                        title="Clear selection"
                        onClick={() => setDrillCaseId(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                  {drillCells.length > 0 && (
                    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                      {drillCells.map((cell) => {
                        const key = `${cell.modelRef.providerConfigId}:${cell.modelRef.model}`;
                        return (
                          <Floater
                            key={`${cell.caseId}:${key}`}
                            radius="panel"
                            elevation="inset"
                            className="flex flex-col gap-2 p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-sp-12 font-medium text-sp-text">
                                {labelForModel(active, key)}
                              </span>
                              <VerdictChip passed={cell.passed} notEvaluated={cell.notEvaluated} />
                            </div>
                            {cell.executed && (
                              <div className="text-sp-11 text-sp-muted">
                                HTTP {cell.executed.status} · {Math.round(cell.executed.latencyMs)}
                                ms
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
                        );
                      })}
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
      </ResizableLayout>

      <DeleteRunDialog />
    </>
  );
}
