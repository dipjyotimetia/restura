import { useMemo, useState } from 'react';
import { Gauge, Play, Square } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useLoadTest } from '../hooks/useLoadTest';
import { computeLoadStats } from '@/lib/shared/loadStats';
import { isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import type { HttpRequest } from '@/types';

interface LoadTestDialogProps {
  request: HttpRequest | null;
  open: boolean;
  onClose: () => void;
}

function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="rounded-sp-btn border border-sp-line px-3 py-2">
      <div className="sp-label">{label}</div>
      <div className="font-mono text-sp-text text-sp-14 tabular-nums">
        {value}
        {unit && <span className="text-sp-dim text-sp-11 ml-0.5">{unit}</span>}
      </div>
    </div>
  );
}

export function LoadTestDialog({ request, open, onClose }: LoadTestDialogProps) {
  const { running, progress, start, stop } = useLoadTest();
  const [iterations, setIterations] = useState(100);
  const [concurrency, setConcurrency] = useState(10);

  const stats = useMemo(() => {
    if (!progress) return null;
    const latencies = progress.samples.filter((s) => s.ok).map((s) => s.timeMs);
    const errors = progress.samples.filter((s) => !s.ok).length;
    return computeLoadStats(latencies, progress.elapsedMs, errors);
  }, [progress]);

  // Throughput over ALL completed requests (success + failure), not just the OK
  // ones the latency percentiles are computed from.
  const rps =
    progress && progress.elapsedMs > 0 ? progress.completed / (progress.elapsedMs / 1000) : 0;

  const pct = progress ? Math.round((progress.completed / progress.total) * 100) : 0;
  const maxBar = stats ? Math.max(stats.p99, 1) : 1;
  const bars: Array<{ label: string; v: number }> = stats
    ? [
        { label: 'p50', v: stats.p50 },
        { label: 'p90', v: stats.p90 },
        { label: 'p95', v: stats.p95 },
        { label: 'p99', v: stats.p99 },
      ]
    : [];

  const handleRun = () => {
    if (!request) return;
    start(request, { iterations, concurrency });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-wide flex items-center gap-2">
            <Gauge className="h-4 w-4" /> Load test
          </DialogTitle>
          <DialogDescription className="text-sp-12 text-sp-dim">
            {request ? `${request.method} ${request.url}` : 'No request'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-end gap-3">
            <label className="flex-1">
              <span className="sp-label">Total requests</span>
              <input
                type="number"
                min={1}
                max={100000}
                value={iterations}
                disabled={running}
                onChange={(e) => setIterations(Math.max(1, Number(e.target.value) || 1))}
                className="mt-1 w-full h-8 px-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono outline-none focus:border-sp-line-strong"
              />
            </label>
            <label className="flex-1">
              <span className="sp-label">Concurrency</span>
              <input
                type="number"
                min={1}
                max={500}
                value={concurrency}
                disabled={running}
                onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value) || 1))}
                className="mt-1 w-full h-8 px-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono outline-none focus:border-sp-line-strong"
              />
            </label>
            {running ? (
              <button
                type="button"
                onClick={stop}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn bg-red-500/15 text-red-500 text-sp-12 font-medium hover:bg-red-500/25 transition-colors"
              >
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={handleRun}
                disabled={!request}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn bg-sp-accent/15 text-sp-accent text-sp-12 font-medium hover:bg-sp-accent/25 transition-colors disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5" /> Run
              </button>
            )}
          </div>

          {!isElectron() && (
            <p className="text-sp-11 text-sp-dim font-mono">
              Browsers cap concurrent connections per origin (~6); desktop reaches higher concurrency.
            </p>
          )}

          {progress && (
            <>
              <div className="h-1.5 rounded-full bg-sp-surface-lo overflow-hidden">
                <div
                  className="h-full bg-sp-accent transition-[width] duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="text-sp-11 text-sp-dim font-mono">
                {progress.completed} / {progress.total} · {pct}%
                {progress.done && ' · done'}
              </div>

              {stats && (
                <>
                  <div className="grid grid-cols-4 gap-2">
                    <Stat label="Req/s" value={rps.toFixed(1)} />
                    <Stat label="Mean" value={stats.mean.toFixed(0)} unit="ms" />
                    <Stat label="Min" value={stats.min.toFixed(0)} unit="ms" />
                    <Stat label="Max" value={stats.max.toFixed(0)} unit="ms" />
                  </div>

                  <div className="space-y-1.5">
                    {bars.map((b) => (
                      <div key={b.label} className="flex items-center gap-2">
                        <span className="font-mono text-sp-11 text-sp-dim w-8">{b.label}</span>
                        <div className="flex-1 h-4 rounded bg-sp-surface-lo overflow-hidden">
                          <div
                            className={cn('h-full bg-sp-accent/60')}
                            style={{ width: `${Math.max(2, (b.v / maxBar) * 100)}%` }}
                          />
                        </div>
                        <span className="font-mono text-sp-11 text-sp-text tabular-nums w-14 text-right">
                          {b.v.toFixed(0)} ms
                        </span>
                      </div>
                    ))}
                  </div>

                  {stats.errors > 0 && (
                    <p className="text-sp-12 text-amber-500 font-mono">
                      {stats.errors} error{stats.errors === 1 ? '' : 's'} (non-2xx/3xx or failed)
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default LoadTestDialog;
