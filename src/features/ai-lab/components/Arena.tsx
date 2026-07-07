import { AlertTriangle, Play, Square, Trash2, Trophy } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useArenaRun } from '../hooks/useArenaRun';
import { computeElo, winRateMatrix } from '../lib/elo';
import { buildModelOptions, toChecklistEntries, toggleKey } from '../lib/modelOptions';
import { plural } from '../lib/plural';
import { useAiLabStore } from '../store/useAiLabStore';
import { useAiLabUiStore } from '../store/useAiLabUiStore';
import { useArenaStore } from '../store/useArenaStore';
import type { ModelRef } from '../types';
import { EmptyState } from './EmptyState';
import { ModelChecklist } from './ModelChecklist';
import { StatusChip } from './StatusChip';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import ResizableLayout from '@/components/shared/ResizableLayout';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Stepper } from '@/components/ui/spatial';
import { Textarea } from '@/components/ui/textarea';
import { formatRelativeTime } from '@/lib/shared/console-format';

/**
 * Background tint for a win-rate cell: green above 50%, red below, intensity
 * scaled by the distance from even. Low alpha so it works on light and dark
 * surfaces; the number stays the primary signal.
 */
function winRateTint(rate: number): string {
  const intensity = Math.min(1, Math.abs(rate - 0.5) * 2);
  const alpha = (0.32 * intensity).toFixed(3);
  // emerald-500 / red-500 to match the pass/fail palette used elsewhere.
  return rate >= 0.5 ? `rgba(16, 185, 129, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;
}

export function Arena() {
  const providers = useAiLabStore((s) => s.providers);
  const datasets = useAiLabStore((s) => s.datasets);
  const runs = useArenaStore((s) => s.runs);
  const deleteRun = useArenaStore((s) => s.deleteRun);
  const { running, progress, error, lastRunId, start, stop } = useArenaRun();

  // Config draft + viewed-run selection live in the session UI store so tab
  // switches don't reset them.
  const draft = useAiLabUiStore((s) => s.arenaDraft);
  const patchDraft = useAiLabUiStore((s) => s.patchArenaDraft);
  const arenaRunId = useAiLabUiStore((s) => s.arenaRunId);
  const setArenaRunId = useAiLabUiStore((s) => s.setArenaRunId);

  const modelOptions = useMemo(() => buildModelOptions(providers), [providers]);
  // Memoized + stable callbacks so the memoized ModelChecklist skips the
  // re-render this component does per completed match while a run streams.
  const checklistEntries = useMemo(() => toChecklistEntries(modelOptions), [modelOptions]);
  const selected = useMemo(() => new Set(draft.selected), [draft.selected]);
  const toggle = useCallback(
    (key: string) => patchDraft({ selected: toggleKey(draft.selected, key) }),
    [draft.selected, patchDraft]
  );
  const setSelected = useCallback(
    (next: Set<string>) => patchDraft({ selected: [...next] }),
    [patchDraft]
  );

  const run = () => {
    const chosen = modelOptions.filter((m) => selected.has(m.key));
    const judge = modelOptions.find((m) => m.key === draft.judgeKey);
    const dataset = datasets[draft.datasetId];
    if (!dataset || chosen.length < 2 || !judge) return;
    const models: ModelRef[] = chosen.map((m) => ({ providerConfigId: m.cfg.id, model: m.model }));
    const modelLabels = Object.fromEntries(chosen.map((m) => [m.key, m.label]));
    setArenaRunId(null); // follow the new run
    start({
      datasetId: draft.datasetId,
      datasetName: dataset.name,
      models,
      modelLabels,
      judgeModel: { providerConfigId: judge.cfg.id, model: judge.model },
      concurrency: draft.concurrency,
      ...(draft.system.trim() ? { system: draft.system.trim() } : {}),
    });
  };

  const sortedRuns = useMemo(
    () => Object.values(runs).sort((a, b) => b.startedAt - a.startedAt),
    [runs]
  );

  // Explicit selection wins; otherwise the in-progress/latest run.
  const activeRun = useMemo(() => {
    if (arenaRunId && runs[arenaRunId]) return runs[arenaRunId];
    if (lastRunId && runs[lastRunId]) return runs[lastRunId];
    return sortedRuns[0];
  }, [runs, sortedRuns, arenaRunId, lastRunId]);

  const { confirm: confirmDeleteRun, DialogComponent: DeleteRunDialog } = useConfirmDialog({
    title: 'Delete arena run',
    description: activeRun
      ? `Delete the "${activeRun.datasetName}" arena run (${plural(activeRun.matches.length, 'match', 'matches')})? This cannot be undone.`
      : '',
    confirmText: 'Delete',
    variant: 'destructive',
  });

  const handleDeleteRun = async () => {
    if (!activeRun) return;
    if (!(await confirmDeleteRun())) return;
    deleteRun(activeRun.id);
    setArenaRunId(null);
  };

  const leaderboard = useMemo(() => {
    if (!activeRun) return [];
    return computeElo(activeRun.modelKeys, activeRun.matches);
  }, [activeRun]);

  const matrix = useMemo(() => {
    if (!activeRun) return null;
    return winRateMatrix(activeRun.modelKeys, activeRun.matches);
  }, [activeRun]);

  const judgeIsContestant = !!draft.judgeKey && selected.has(draft.judgeKey);
  const canRun = !!draft.datasetId && selected.size >= 2 && !!draft.judgeKey && !running;

  return (
    <>
      <ResizableLayout defaultSplit={34} minSplit={24} maxSplit={55}>
        {/* Config pane. */}
        <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
          <div className="space-y-1.5">
            <Label htmlFor="arena-dataset" className="sp-label">
              Dataset
            </Label>
            <Select value={draft.datasetId} onValueChange={(v) => patchDraft({ datasetId: v })}>
              <SelectTrigger id="arena-dataset">
                <SelectValue placeholder="Select a dataset" />
              </SelectTrigger>
              <SelectContent>
                {Object.values(datasets).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name} ({d.cases.length})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sp-11 text-sp-text-dim">
              Each case&apos;s <code>prompt</code>/<code>input</code> var is sent to every model.
            </p>
          </div>
          <div className="space-y-1.5">
            <span className="sp-label">Contestants (≥ 2)</span>
            <ModelChecklist
              models={checklistEntries}
              selected={selected}
              onToggle={toggle}
              onChangeSelected={setSelected}
              emptyText="Add providers + discover models first."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="arena-judge" className="sp-label">
              Judge model
            </Label>
            <Select value={draft.judgeKey} onValueChange={(v) => patchDraft({ judgeKey: v })}>
              <SelectTrigger id="arena-judge">
                <SelectValue placeholder="Select a judge" />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((m) => (
                  <SelectItem key={m.key} value={m.key}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {judgeIsContestant && (
              <p className="flex items-start gap-1.5 text-sp-11 text-amber-500">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                The judge is also a contestant — models tend to prefer their own outputs, which
                skews the ranking. Prefer a neutral judge.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="arena-system" className="sp-label">
              System prompt (optional)
            </Label>
            <Textarea
              id="arena-system"
              value={draft.system}
              onChange={(e) => patchDraft({ system: e.target.value })}
              rows={2}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <span className="sp-label">Concurrency</span>
              <Stepper
                value={draft.concurrency}
                onChange={(v) => patchDraft({ concurrency: v })}
                min={1}
                max={16}
                ariaLabel="Concurrency"
              />
            </div>
            <p className="text-sp-11 text-sp-text-dim">
              Parallel model calls — lower it if your provider rate-limits.
            </p>
          </div>
          {running ? (
            <Button variant="destructive" size="cta" onClick={stop} className="w-full">
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          ) : (
            <Button variant="cta" size="cta" onClick={run} disabled={!canRun} className="w-full">
              <Play className="h-3.5 w-3.5" /> Run arena
            </Button>
          )}
          {progress && (
            <div className="flex items-center justify-between gap-2">
              <StatusChip state={progress.phase === 'done' ? 'done' : 'running'} />
              <span className="text-sp-12 text-sp-muted">
                {progress.phase === 'generating'
                  ? 'Generating answers'
                  : progress.phase === 'judging'
                    ? 'Judging pairs'
                    : 'Done'}{' '}
                · {progress.completed}/{progress.total}
              </span>
            </div>
          )}
          {error && <p className="text-sp-12 text-destructive">{error}</p>}
        </div>

        {/* Leaderboard + matrix. */}
        <div className="flex-1 overflow-auto p-4">
          {sortedRuns.length > 0 && (
            <div className="mb-4 flex items-center gap-1.5">
              <Select value={activeRun?.id ?? ''} onValueChange={(id) => setArenaRunId(id || null)}>
                <SelectTrigger className="w-72" aria-label="Arena run">
                  <SelectValue placeholder="Select a run…" />
                </SelectTrigger>
                <SelectContent>
                  {sortedRuns.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.datasetName} · {plural(r.modelKeys.length, 'model')} ·{' '}
                      {formatRelativeTime(r.startedAt)}
                      {r.status !== 'done' ? ` · ${r.status}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeRun && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete arena run"
                  title="Delete arena run"
                  onClick={() => void handleDeleteRun()}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              )}
            </div>
          )}
          {activeRun && leaderboard.length > 0 ? (
            <div className="space-y-5">
              <div>
                <h3 className="sp-label mb-2">
                  Leaderboard — {activeRun.datasetName} (
                  {plural(activeRun.matches.length, 'match', 'matches')})
                </h3>
                <table className="w-full text-sp-12">
                  <thead>
                    <tr className="border-b border-sp-line text-left text-sp-11 uppercase tracking-wide text-sp-muted">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="py-2 pr-3 font-medium">Model</th>
                      <th className="py-2 pr-3 text-right font-medium">Elo</th>
                      <th className="py-2 pr-3 text-right font-medium">W</th>
                      <th className="py-2 pr-3 text-right font-medium">L</th>
                      <th className="py-2 pr-3 text-right font-medium">T</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.map((e, i) => (
                      <tr
                        key={e.key}
                        className="border-b border-sp-line transition-colors hover:bg-sp-hover"
                      >
                        <td className="py-2 pr-3 tabular-nums text-sp-muted">{i + 1}</td>
                        <td className="py-2 pr-3 truncate text-sp-text">
                          {activeRun.modelLabels[e.key] ?? e.key}
                        </td>
                        <td className="py-2 pr-3 text-right font-medium tabular-nums text-sp-text">
                          {e.rating}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{e.wins}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{e.losses}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{e.ties}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {matrix && (
                <div>
                  <h3 className="sp-label mb-2">Win-rate (row vs column)</h3>
                  <div className="overflow-auto">
                    <table className="text-sp-11">
                      <thead>
                        <tr>
                          <th className="p-1.5" aria-label="Model" />
                          {activeRun.modelKeys.map((k) => (
                            <th key={k} className="max-w-[7rem] truncate p-1.5 text-sp-muted">
                              {activeRun.modelLabels[k] ?? k}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {activeRun.modelKeys.map((r) => (
                          <tr key={r}>
                            <td className="max-w-[7rem] truncate p-1.5 text-sp-muted">
                              {activeRun.modelLabels[r] ?? r}
                            </td>
                            {activeRun.modelKeys.map((c) => {
                              const cell = matrix[r]?.[c];
                              const rate = cell?.rate;
                              return (
                                <td
                                  key={c}
                                  className="p-1.5 text-center tabular-nums"
                                  style={
                                    r !== c && rate !== null && rate !== undefined
                                      ? { backgroundColor: winRateTint(rate) }
                                      : undefined
                                  }
                                >
                                  {r === c ? (
                                    <span className="text-sp-text-dim">—</span>
                                  ) : rate === null || rate === undefined ? (
                                    <span className="text-sp-text-dim">·</span>
                                  ) : (
                                    `${Math.round(rate * 100)}%`
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              fill
              icon={Trophy}
              message="Pick a dataset, two or more contestant models, and a judge, then run a round-robin to rank them by Elo."
            />
          )}
        </div>
      </ResizableLayout>

      <DeleteRunDialog />
    </>
  );
}
