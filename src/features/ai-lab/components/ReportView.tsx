import { useMemo, useState } from 'react';
import { BarChart3, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { percentile } from '@/lib/shared/loadStats';
import { useEvalRunStore } from '../store/useEvalRunStore';
import { EmptyState } from './EmptyState';
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

  if (sorted.length === 0) {
    return <EmptyState icon={BarChart3} message="No runs yet. Run an eval first." />;
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <div className="space-y-2">
        {sorted.map((r) => (
          <button
            key={r.id}
            onClick={() => setActiveId(r.id)}
            className={cn(
              'flex w-full items-center justify-between rounded-sp-btn border px-3 py-2 text-left text-sp-13 transition-colors',
              active?.id === r.id
                ? 'border-sp-accent bg-[var(--sp-accent-glow-15)] text-sp-text'
                : 'border-sp-line text-sp-text hover:bg-sp-hover'
            )}
          >
            <span className="truncate">
              {r.configName}
              <span className="ml-1 text-[10px] text-sp-muted">{r.status}</span>
            </span>
            <span className="text-sp-12 text-sp-muted">
              {r.cells.length}/{r.totalCells}
            </span>
          </button>
        ))}
      </div>

      {active ? (
        <Floater radius="panel" elevation="float" className="space-y-3 bg-sp-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sp-13 font-semibold text-sp-text">{active.configName}</h2>
            <Button
              variant="ghost"
              size="sm"
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
              <thead className="text-sp-muted">
                <tr className="border-b border-sp-line text-left">
                  <th className="py-1 pr-3">Model</th>
                  <th className="py-1 pr-3">Pass rate</th>
                  <th className="py-1 pr-3">Δ vs prev</th>
                  <th className="py-1 pr-3">p50</th>
                  <th className="py-1 pr-3">p95</th>
                  <th className="py-1 pr-3">Cost</th>
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
                        <td className="py-1 pr-3 font-medium">{m.label}</td>
                        <td className="py-1 pr-3">
                          {(m.passRate * 100).toFixed(0)}% ({m.passed}/{m.total})
                        </td>
                        <td className="py-1 pr-3">
                          {delta === null ? (
                            '—'
                          ) : (
                            <span
                              className={
                                delta > 0 ? 'text-emerald-500' : delta < 0 ? 'text-destructive' : ''
                              }
                            >
                              {delta > 0 ? '+' : ''}
                              {(delta * 100).toFixed(0)}%
                            </span>
                          )}
                        </td>
                        <td className="py-1 pr-3">{Math.round(m.p50)}ms</td>
                        <td className="py-1 pr-3">{Math.round(m.p95)}ms</td>
                        <td className="py-1 pr-3">
                          {m.cost === null ? '—' : m.cost === 0 ? 'free' : `$${m.cost.toFixed(4)}`}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {previous && (
            <p className="text-[10px] text-sp-muted">
              Δ compares against the previous run of this eval.
            </p>
          )}
        </Floater>
      ) : (
        <EmptyState message="Select a run." />
      )}
    </div>
  );
}
