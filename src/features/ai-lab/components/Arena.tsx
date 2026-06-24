import { Play, Square, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useArenaRun } from '../hooks/useArenaRun';
import { computeElo, winRateMatrix } from '../lib/elo';
import { useAiLabStore } from '../store/useAiLabStore';
import { useArenaStore } from '../store/useArenaStore';
import type { AiLabProviderConfig, ModelRef } from '../types';
import { EmptyState } from './EmptyState';
import { ModelChecklist } from './ModelChecklist';
import { StatusChip } from './StatusChip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

interface ModelOption {
  key: string;
  cfg: AiLabProviderConfig;
  model: string;
  label: string;
}

export function Arena() {
  const providers = useAiLabStore((s) => s.providers);
  const datasets = useAiLabStore((s) => s.datasets);
  const runs = useArenaStore((s) => s.runs);
  const { running, progress, error, lastRunId, start, stop } = useArenaRun();

  const [datasetId, setDatasetId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [judgeKey, setJudgeKey] = useState('');
  const [system, setSystem] = useState('');
  const [concurrency, setConcurrency] = useState(4);

  const modelOptions = useMemo<ModelOption[]>(() => {
    const out: ModelOption[] = [];
    for (const cfg of Object.values(providers))
      for (const model of cfg.models)
        out.push({ key: `${cfg.id}:${model}`, cfg, model, label: `${cfg.label} · ${model}` });
    return out;
  }, [providers]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const run = () => {
    const chosen = modelOptions.filter((m) => selected.has(m.key));
    const judge = modelOptions.find((m) => m.key === judgeKey);
    const dataset = datasets[datasetId];
    if (!dataset || chosen.length < 2 || !judge) return;
    const models: ModelRef[] = chosen.map((m) => ({ providerConfigId: m.cfg.id, model: m.model }));
    const modelLabels = Object.fromEntries(chosen.map((m) => [m.key, m.label]));
    start({
      datasetId,
      datasetName: dataset.name,
      models,
      modelLabels,
      judgeModel: { providerConfigId: judge.cfg.id, model: judge.model },
      concurrency,
      ...(system.trim() ? { system: system.trim() } : {}),
    });
  };

  // Latest finished run (or the one in progress) drives the leaderboard.
  const activeRun = useMemo(() => {
    if (lastRunId && runs[lastRunId]) return runs[lastRunId];
    return Object.values(runs).sort((a, b) => b.startedAt - a.startedAt)[0];
  }, [runs, lastRunId]);

  const leaderboard = useMemo(() => {
    if (!activeRun) return [];
    return computeElo(activeRun.modelKeys, activeRun.matches);
  }, [activeRun]);

  const matrix = useMemo(() => {
    if (!activeRun) return null;
    return winRateMatrix(activeRun.modelKeys, activeRun.matches);
  }, [activeRun]);

  const canRun = !!datasetId && selected.size >= 2 && !!judgeKey;

  return (
    <div className="flex h-full">
      {/* Config pane. */}
      <div className="flex w-[400px] shrink-0 flex-col gap-4 overflow-auto border-r border-sp-line p-4">
        <div className="space-y-1.5">
          <span className="sp-label">Dataset</span>
          <Select value={datasetId} onValueChange={setDatasetId}>
            <SelectTrigger>
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
            models={modelOptions}
            selected={selected}
            onToggle={toggle}
            emptyText="Add providers + discover models first."
          />
        </div>
        <div className="space-y-1.5">
          <span className="sp-label">Judge model</span>
          <Select value={judgeKey} onValueChange={setJudgeKey}>
            <SelectTrigger>
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
        </div>
        <div className="space-y-1.5">
          <span className="sp-label">System prompt (optional)</span>
          <Textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={2} />
        </div>
        <div className="flex items-center gap-3">
          <span className="sp-label">Concurrency</span>
          <Input
            type="number"
            min={1}
            max={16}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
            className="w-20"
          />
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
              {progress.phase} {progress.completed}/{progress.total}
            </span>
          </div>
        )}
        {error && <p className="text-sp-12 text-destructive">{error}</p>}
      </div>

      {/* Leaderboard + matrix. */}
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {activeRun && leaderboard.length > 0 ? (
          <div className="space-y-5">
            <div>
              <h3 className="sp-label mb-2">
                Leaderboard — {activeRun.datasetName} ({activeRun.matches.length} matches)
              </h3>
              <table className="w-full text-sp-12">
                <thead>
                  <tr className="text-left text-sp-muted">
                    <th className="py-1.5">#</th>
                    <th>Model</th>
                    <th className="text-right">Elo</th>
                    <th className="text-right">W</th>
                    <th className="text-right">L</th>
                    <th className="text-right">T</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((e, i) => (
                    <tr key={e.key} className="border-t border-sp-line">
                      <td className="py-1.5 tabular-nums text-sp-muted">{i + 1}</td>
                      <td className="truncate text-sp-text">
                        {activeRun.modelLabels[e.key] ?? e.key}
                      </td>
                      <td className="text-right font-medium tabular-nums text-sp-text">
                        {e.rating}
                      </td>
                      <td className="text-right tabular-nums">{e.wins}</td>
                      <td className="text-right tabular-nums">{e.losses}</td>
                      <td className="text-right tabular-nums">{e.ties}</td>
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
                              <td key={c} className="p-1.5 text-center tabular-nums">
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
    </div>
  );
}
