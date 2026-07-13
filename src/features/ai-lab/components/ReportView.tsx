import { serializeContentBlocks } from '@shared/agent-lab';
import { ArrowDown, ArrowUp, BarChart3, Download, Trash2, X } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { modelKey, parseModelKey } from '../lib/modelOptions';
import { newestFirst } from '../lib/newestFirst';
import { runToCsv, runToJson, runToMarkdown } from '../lib/reportExport';
import { summarizeVars } from '../lib/summarizeVars';
import { useAgentRunLiveStore } from '../run-engine/agentRunService';
import { adaptEvalRunReport, type AiLabReportEnvelope } from '../run-engine/reportEnvelope';
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
  return run.modelLabels?.[key] ?? (parseModelKey(key).model || key);
}

function statsByModel(run: EvalRun): ModelStats[] {
  const groups = new Map<string, EvalCellResult[]>();
  for (const cell of run.cells) {
    const key = modelKey(cell.modelRef);
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

function AgentReportDetail({
  report,
  onDelete,
}: {
  report: Extract<AiLabReportEnvelope, { kind: 'agent-suite' }>;
  onDelete: () => void;
}) {
  const payload = report.payload;
  const taskById = new Map(report.suite.tasks.map((task) => [task.id, task]));
  const resourceUsage = payload.results.reduce(
    (total, result) => {
      for (const event of result.trace.events) {
        if (event.type === 'model.failed') {
          total.calls += 1;
        } else if (event.type === 'model.completed') {
          total.calls += 1;
          if (event.usage) {
            total.usageKnown += 1;
            total.inputTokens += event.usage.inputTokens;
            total.outputTokens += event.usage.outputTokens;
          }
          if (event.costUSD !== undefined) {
            total.costKnown += 1;
            total.costUSD += event.costUSD;
          }
        }
      }
      for (const score of result.scores) {
        if (score.kind === 'judge') {
          total.calls += score.resourceCalls?.attempted ?? 1;
          total.usageKnown += score.resourceCalls?.usageKnown ?? (score.usage ? 1 : 0);
          total.costKnown +=
            score.resourceCalls?.costKnown ?? (score.costUSD !== undefined ? 1 : 0);
        }
        if (score.usage) {
          total.inputTokens += score.usage.inputTokens;
          total.outputTokens += score.usage.outputTokens;
        }
        if (score.costUSD !== undefined) {
          total.costUSD += score.costUSD;
        }
      }
      return total;
    },
    { inputTokens: 0, outputTokens: 0, costUSD: 0, calls: 0, usageKnown: 0, costKnown: 0 }
  );
  const knowledge = (known: number) =>
    known === 0 ? 'unknown' : known === resourceUsage.calls ? 'fully known' : 'partially known';
  const exportJson = () => {
    const safe = report.name.replace(/[^a-z0-9-_]+/gi, '_') || 'agent-suite';
    downloadBlob(JSON.stringify(report, null, 2), `${safe}.json`, 'application/json');
  };

  return (
    <Floater radius="panel" elevation="float" className="space-y-4 bg-sp-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sp-13 font-semibold text-sp-text">{report.name}</h2>
          <p className="text-sp-11 text-sp-muted">
            {payload.summary.passed}/{payload.summary.total} passed ·{' '}
            {(payload.summary.passRate * 100).toFixed(1)}% pass rate
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={exportJson}>
            JSON
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Delete run" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-3 border-t border-sp-line pt-3">
        <Stat
          label="95% confidence"
          value={`${(payload.summary.confidence95.low * 100).toFixed(1)}–${(payload.summary.confidence95.high * 100).toFixed(1)}%`}
        />
        <Stat
          label="Usage"
          value={
            resourceUsage.usageKnown
              ? `${resourceUsage.inputTokens} in · ${resourceUsage.outputTokens} out · ${knowledge(resourceUsage.usageKnown)}`
              : 'unknown'
          }
        />
        <Stat
          label="Cost"
          value={
            resourceUsage.costKnown
              ? `$${resourceUsage.costUSD.toFixed(6)} · ${knowledge(resourceUsage.costKnown)}`
              : 'unknown'
          }
        />
        <Stat
          label="Outcomes"
          value={`${payload.summary.total} total · ${payload.summary.passed} passed · ${payload.summary.failed} failed · ${payload.summary.errors} errors · ${payload.summary.cancelled} cancelled`}
        />
        <Stat
          label="Reliability"
          value={`pass@k ${JSON.stringify(payload.summary.passAtK)} · pass^k ${JSON.stringify(payload.summary.passToK)}`}
        />
      </div>

      <div className="space-y-3 border-t border-sp-line pt-3">
        <h3 className="sp-label">Task reliability</h3>
        {payload.summary.reliabilityByCase.map((reliability) => {
          const task = taskById.get(reliability.taskId);
          return (
            <Floater
              key={`${reliability.agentId}:${reliability.taskId}`}
              radius="panel"
              elevation="inset"
              className="space-y-2 p-3"
            >
              <div className="flex items-center justify-between gap-2 text-sp-12">
                <span className="font-medium text-sp-text">
                  {reliability.taskId} · {reliability.agentId}
                </span>
                <span className="tabular-nums text-sp-muted">
                  {(reliability.passRate * 100).toFixed(1)}% ({reliability.passed}/
                  {reliability.total}) · CI {(reliability.confidence95.low * 100).toFixed(1)}–
                  {(reliability.confidence95.high * 100).toFixed(1)}%
                </span>
              </div>
              <div className="text-sp-11 text-sp-muted">
                pass@k {JSON.stringify(reliability.passAtK)} · pass^k{' '}
                {JSON.stringify(reliability.passToK)}
              </div>
              <div className="grid gap-2 text-sp-11 md:grid-cols-2">
                <div>
                  <span className="sp-label">Input</span>
                  <pre className="mt-1 whitespace-pre-wrap text-sp-text">
                    {task ? serializeContentBlocks(task.input) : '(task unavailable)'}
                  </pre>
                </div>
                <div>
                  <span className="sp-label">Reference</span>
                  <pre className="mt-1 whitespace-pre-wrap text-sp-text">
                    {task?.reference ? serializeContentBlocks(task.reference) : '(none)'}
                  </pre>
                </div>
              </div>
            </Floater>
          );
        })}
      </div>

      <div className="space-y-3 border-t border-sp-line pt-3">
        <h3 className="sp-label">Trials, grades and traces</h3>
        {payload.results.map((result) => (
          <Floater
            key={`${result.agentId}:${result.taskId}:${result.trial}`}
            radius="panel"
            elevation="inset"
            className="space-y-2 p-3"
          >
            <div className="flex items-center justify-between text-sp-12">
              <span className="font-medium text-sp-text">
                {result.taskId} · trial {result.trial}
              </span>
              <StatusChip state={result.status} />
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-sp-bg p-2 text-sp-11 text-sp-text">
              {serializeContentBlocks(result.output) || '(empty output)'}
            </pre>
            {result.error && <div className="text-sp-11 text-destructive">{result.error}</div>}
            {result.scores.map((score) => (
              <div key={score.graderId} className="text-sp-11 text-sp-muted">
                <span className={score.passed ? 'text-emerald-500' : 'text-destructive'}>
                  {score.graderId}: {score.passed ? 'pass' : 'fail'}
                </span>
                {score.score !== undefined ? ` · ${score.score.toFixed(3)}` : ''}
                {score.detail ? ` · ${score.detail}` : ''}
                {score.minimumQuorum !== undefined ? ` · quorum ${score.minimumQuorum}` : ''}
                {score.judgeVotes?.map((vote) => (
                  <div key={`${vote.providerId}:${vote.model}`}>
                    {vote.model}: {vote.label} ({vote.score.toFixed(3)})
                    {vote.reasoning ? ` · ${vote.reasoning}` : ''}
                  </div>
                ))}
                {score.judgeFailures?.map((failure) => (
                  <div key={`${failure.providerId}:${failure.model}`} className="text-destructive">
                    {failure.model} · {failure.error}
                  </div>
                ))}
              </div>
            ))}
            <details>
              <summary className="cursor-pointer text-sp-11 text-sp-muted">Trace events</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-sp-bg p-2 text-sp-10 text-sp-text">
                {result.trace.events
                  .map((event) => `${event.timestamp} · ${event.type} · ${JSON.stringify(event)}`)
                  .join('\n')}
              </pre>
            </details>
          </Floater>
        ))}
      </div>
    </Floater>
  );
}

export function ReportView() {
  const runs = useEvalRunStore((s) => s.runs);
  const deleteRun = useEvalRunStore((s) => s.deleteRun);
  const datasets = useAiLabStore((s) => s.datasets);
  const runReports = useAiLabStore((s) => s.runReports);
  const liveAgentReport = useAgentRunLiveStore((s) => s.completedReport);
  const removeRunReport = useAiLabStore((s) => s.removeRunReport);
  const evalSorted = useMemo(() => newestFirst(runs), [runs]);
  const sorted = useMemo(() => {
    const persisted = Object.values(runReports);
    if (liveAgentReport && !runReports[liveAgentReport.id]) persisted.push(liveAgentReport);
    const persistedIds = new Set(persisted.map((report) => report.id));
    return [
      ...persisted,
      ...evalSorted.filter((run) => !persistedIds.has(run.id)).map(adaptEvalRunReport),
    ].sort((left, right) => right.startedAt - left.startedAt);
  }, [evalSorted, liveAgentReport, runReports]);
  // Selection lives in the UI store so "View report" in the Evals tab can hand
  // a run off to us, and so the selection survives tab switches.
  const activeId = useAiLabUiStore((s) => s.reportRunId);
  const setActiveId = useAiLabUiStore((s) => s.setReportRunId);
  const drillCaseId = useAiLabUiStore((s) => s.reportDrillCaseId);
  const setDrillCaseId = useAiLabUiStore((s) => s.setReportDrillCaseId);
  const setTab = useAiLabUiStore((s) => s.setTab);
  const selected =
    (activeId ? sorted.find((report) => report.id === activeId) : undefined) ?? sorted[0];
  const active = selected?.kind === 'eval' ? selected.payload : undefined;
  const { confirm: confirmDelete, DialogComponent: DeleteRunDialog } = useConfirmDialog({
    title: 'Delete run',
    description: selected ? `Delete the report for "${selected.name}"? This cannot be undone.` : '',
    confirmText: 'Delete',
    variant: 'destructive',
  });

  // Previous run of the SAME eval config — enables regression compare.
  const previous = useMemo(() => {
    if (!active) return undefined;
    return evalSorted.find(
      (r) => r.evalConfigId === active.evalConfigId && r.startedAt < active.startedAt
    );
  }, [active, evalSorted]);

  // One sorted stats list drives both the table rows and the matrix columns
  // (previously the same sort ran twice, once unmemoized in JSX).
  const sortedStats = useMemo(
    () => (active ? statsByModel(active).sort((a, b) => b.passRate - a.passRate) : []),
    [active]
  );
  const prevStatsByKey = useMemo(
    () => new Map(previous ? statsByModel(previous).map((m) => [m.key, m]) : []),
    [previous]
  );
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
  const modelKeys = useMemo(() => sortedStats.map((m) => m.key), [sortedStats]);

  // caseId → cell lookup for the matrix.
  const cellByCaseAndModel = useMemo(() => {
    const map = new Map<string, EvalCellResult>();
    if (!active) return map;
    for (const c of active.cells) {
      map.set(`${c.caseId}|${modelKey(c.modelRef)}`, c);
    }
    return map;
  }, [active]);

  // O(1) case lookup for the matrix rows (a linear find per row made the
  // table O(rows × cases) per render).
  const caseById = useMemo(() => {
    const dataset = active?.datasetId ? datasets[active.datasetId] : undefined;
    return new Map((dataset?.cases ?? []).map((c) => [c.id, c]));
  }, [active, datasets]);

  /**
   * Short human description of a case: its first var values, looked up from
   * the run's dataset. Falls back to the id prefix when the dataset (or case)
   * has since been deleted.
   */
  const caseLabel = useCallback(
    (caseId: string, index: number): string => {
      const c = caseById.get(caseId);
      if (!c) return `Case ${index + 1} (${caseId.slice(0, 8)})`;
      const vars = summarizeVars(c.vars, 2, 20);
      return vars ? `Case ${index + 1} — ${vars}` : `Case ${index + 1}`;
    },
    [caseById]
  );

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
    if (!selected) return;
    if (!(await confirmDelete())) return;
    if (selected.kind === 'eval') deleteRun(selected.id);
    if (runReports[selected.id]) await removeRunReport(selected.id);
    setActiveId(null); // also clears the drill-down (store invariant)
  };

  if (sorted.length === 0) {
    return (
      <EmptyState
        fill
        icon={BarChart3}
        message="No reports yet. Run an eval to create the first comparison report."
        action={
          <Button variant="outline" size="sm" onClick={() => setTab('evals')}>
            Configure an eval
          </Button>
        }
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
              onClick={() => setActiveId(r.id)}
              className={cn(
                'w-full rounded-sp-btn border px-3 py-2.5 text-left transition-colors',
                selected?.id === r.id
                  ? 'border-sp-accent bg-[var(--sp-accent-glow-15)]'
                  : 'border-sp-line hover:bg-sp-hover'
              )}
            >
              <div className="truncate text-sp-13 text-sp-text">{r.name}</div>
              <div className="mt-0.5 truncate text-sp-11 text-sp-muted">
                {formatRelativeTime(r.startedAt)}
                {r.kind === 'eval' && r.payload.datasetName
                  ? ` · ${r.payload.datasetName}`
                  : r.kind === 'agent-suite'
                    ? ' · Agent suite'
                    : ''}
              </div>
              <div className="mt-1 flex items-center justify-between">
                <StatusChip state={r.status} />
                <span className="text-sp-11 text-sp-muted tabular-nums">
                  {r.kind === 'eval'
                    ? `${r.payload.cells.length}/${r.payload.totalCells}`
                    : `${r.payload.summary.passed}/${r.payload.summary.total}`}
                </span>
              </div>
            </button>
          ))}
        </div>

        {/* Report — detail pane, fills the window. */}
        <div className="flex-1 overflow-auto p-4">
          {selected?.kind === 'agent-suite' ? (
            <AgentReportDetail report={selected} onDelete={() => void handleDeleteClick()} />
          ) : active ? (
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
                    {sortedStats.map((m) => {
                      const prev = prevStatsByKey.get(m.key);
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
                        const key = modelKey(cell.modelRef);
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
