import { serializeContentBlocks } from '@shared/agent-lab';
import { BarChart3, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import ResizableLayout from '@/components/shared/ResizableLayout';
import { Button } from '@/components/ui/button';
import { Floater, Stat } from '@/components/ui/spatial';
import { downloadBlob } from '@/lib/shared/file-utils';
import { newestFirst } from '../lib/newestFirst';
import { runToCsv, runToJson, runToMarkdown } from '../lib/reportExport';
import { useAgentRunLiveStore } from '../run-engine/agentRunService';
import { type AiLabReportEnvelope, adaptEvalRunReport } from '../run-engine/reportEnvelope';
import { useAiLabStore } from '../store/useAiLabStore';
import { useAiLabUiStore } from '../store/useAiLabUiStore';
import { useEvalRunStore } from '../store/useEvalRunStore';
import { EmptyState } from './EmptyState';
import { ReportMatrix } from './ReportMatrix';
import { ReportRunList } from './ReportRunList';
import { judgeStats, ReportSummary, statsByModel } from './ReportSummary';
import { StatusChip } from './StatusChip';

// Preserved export for the focused aggregation tests and downstream consumers.
export { judgeStats } from './ReportSummary';

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

      {payload.execution?.modelCapabilities.length ? (
        <div className="space-y-2 border-t border-sp-line pt-3">
          <h3 className="sp-label">Resolved model capabilities</h3>
          {payload.execution.modelCapabilities.map((resolved) => (
            <div
              key={`${resolved.providerId}:${resolved.model}`}
              className="text-sp-11 text-sp-muted"
            >
              <span className="font-medium text-sp-text">
                {resolved.providerId}/{resolved.model}
              </span>{' '}
              · {resolved.assertedByUser ? 'user asserted' : resolved.provenance.source} · tools{' '}
              {resolved.capabilities.toolCalling ? 'enabled' : 'disabled'}
            </div>
          ))}
        </div>
      ) : null}

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
  const judge = useMemo(
    () => (active ? judgeStats(active) : { judged: 0, avgVariance: null, criteria: [] }),
    [active]
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
        <ReportRunList reports={sorted} selectedId={selected?.id} onSelect={setActiveId} />

        {/* Report — detail pane, fills the window. */}
        <div className="flex-1 overflow-auto p-4">
          {selected?.kind === 'agent-suite' ? (
            <AgentReportDetail report={selected} onDelete={() => void handleDeleteClick()} />
          ) : active ? (
            <ReportSummary
              run={active}
              stats={sortedStats}
              previousStatsByKey={prevStatsByKey}
              judge={judge}
              hasPreviousRun={Boolean(previous)}
              onExport={exportRun}
              onDelete={() => void handleDeleteClick()}
            >
              <ReportMatrix
                run={active}
                dataset={active.datasetId ? datasets[active.datasetId] : undefined}
                stats={sortedStats}
                drillCaseId={drillCaseId}
                onDrillCaseChange={setDrillCaseId}
              />
            </ReportSummary>
          ) : (
            <EmptyState fill message="Select a run to view its report." />
          )}
        </div>
      </ResizableLayout>

      <DeleteRunDialog />
    </>
  );
}
