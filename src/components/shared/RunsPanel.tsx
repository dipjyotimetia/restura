import { Copy, Square, Server, Gauge, Trash2, RotateCw, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CollectionRunDetail } from '@/features/collections/components/CollectionRunDetail';
import type { CollectionRunResult } from '@/features/collections/lib/collectionRunner';
import { getMethodColor, formatRelativeTime } from '@/lib/shared/console-format';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import { useLoadTestStore } from '@/store/useLoadTestStore';
import { useMockStore } from '@/store/useMockStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useUiStore } from '@/store/useUiStore';

function SectionHeader({
  icon,
  title,
  right,
}: {
  icon: React.ReactNode;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-1.5 text-[11px] font-mono font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </div>
      {right}
    </div>
  );
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-0.5 text-[9px] font-bold font-mono uppercase border',
        getMethodColor(method)
      )}
    >
      {method}
    </span>
  );
}

/**
 * The "Runs" sidebar panel — a dedicated place to observe the desktop mock
 * server (running state, base URL, served routes) and recent load-test results
 * (percentiles + throughput), both of which previously only surfaced
 * transiently (a toast / a modal). Read-only observation plus stop / rerun.
 */
export function RunsPanel() {
  const mockStatus = useMockStore((s) => s.status);
  const mockRoutes = useMockStore((s) => s.routes);
  const setMockStatus = useMockStore((s) => s.setStatus);
  const setMockRoutes = useMockStore((s) => s.setRoutes);
  const runs = useLoadTestStore((s) => s.runs);
  const clearRuns = useLoadTestStore((s) => s.clearRuns);
  const collectionRuns = useCollectionRunStore((s) => s.runs);
  const clearCollectionRuns = useCollectionRunStore((s) => s.clearRuns);
  const [detailRun, setDetailRun] = useState<CollectionRunResult | null>(null);

  const stopMock = async () => {
    const api = getElectronAPI();
    if (!api?.mock) return;
    const res = await api.mock.stop();
    if (res.ok) {
      setMockStatus(res.status);
      setMockRoutes([]);
      toast.success('Mock server stopped');
    } else {
      toast.error(`Failed to stop mock server: ${res.error}`);
    }
  };

  const copyUrl = () => {
    if (!mockStatus.baseUrl) return;
    void navigator.clipboard.writeText(mockStatus.baseUrl);
    toast.success('Base URL copied');
  };

  const rerun = (request: (typeof runs)[number]['request']) => {
    useRequestStore.getState().openTab(request, { switchTo: true });
    useUiStore.getState().setLoadTestOpen(true);
  };

  return (
    <div className="flex flex-col gap-5 text-xs">
      {/* Mock server */}
      <section>
        <SectionHeader
          icon={<Server className="h-3 w-3" />}
          title="Mock server"
          right={
            mockStatus.running ? (
              <button
                type="button"
                onClick={stopMock}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-500/10 transition-colors"
              >
                <Square className="h-3 w-3" /> Stop
              </button>
            ) : undefined
          }
        />
        {!isElectron() ? (
          <p className="text-[11px] text-sp-muted font-mono">Desktop-only feature.</p>
        ) : mockStatus.running ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={copyUrl}
              className="group flex w-full items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-left hover:bg-muted/50 transition-colors"
            >
              <span className="size-1.5 rounded-full bg-emerald-500 shrink-0 animate-pulse" />
              <span className="font-mono text-[11px] text-foreground truncate flex-1">
                {mockStatus.baseUrl}
              </span>
              <Copy className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
            <div className="text-[10px] text-muted-foreground font-mono">
              {mockRoutes.length} route{mockRoutes.length === 1 ? '' : 's'}
            </div>
            <div className="rounded-md border border-border/40 divide-y divide-border/30 max-h-56 overflow-auto">
              {mockRoutes.map((r, i) => (
                <div
                  key={`${r.method}-${r.path}-${i}`}
                  className="flex items-center gap-2 px-2 py-1"
                >
                  <MethodBadge method={r.method} />
                  <span className="font-mono text-[11px] text-muted-foreground truncate">
                    {r.path}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-sp-muted font-mono leading-relaxed">
            Not running. Start one from a collection&rsquo;s ⋯ menu &rarr; &ldquo;Start mock
            server&rdquo;.
          </p>
        )}
      </section>

      {/* Collection runs */}
      <section>
        <SectionHeader
          icon={<ListChecks className="h-3 w-3" />}
          title="Collection runs"
          right={
            collectionRuns.length > 0 ? (
              <button
                type="button"
                onClick={clearCollectionRuns}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition-colors"
              >
                <Trash2 className="h-3 w-3" /> Clear
              </button>
            ) : undefined
          }
        />
        {collectionRuns.length === 0 ? (
          <p className="text-[11px] text-sp-muted font-mono leading-relaxed">
            No runs yet. Run a collection or folder from its context menu.
          </p>
        ) : (
          <div className="space-y-2">
            {collectionRuns.map((run) => {
              const ok = run.summary.failed === 0;
              return (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setDetailRun(run)}
                  className="w-full text-left rounded-md border border-border/50 bg-muted/20 p-2 space-y-1.5 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'size-1.5 rounded-full shrink-0',
                        ok ? 'bg-emerald-500' : 'bg-red-500'
                      )}
                    />
                    <span
                      className="font-mono text-[11px] text-foreground truncate flex-1"
                      title={run.scopeName}
                    >
                      {run.scopeName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelativeTime(run.startedAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums pl-3.5">
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {run.summary.passed} ✓
                    </span>
                    {run.summary.failed > 0 && (
                      <span className="text-red-600 dark:text-red-400">{run.summary.failed} ✗</span>
                    )}
                    {run.summary.skipped > 0 && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {run.summary.skipped} skip
                      </span>
                    )}
                    <span className="text-sp-muted ml-auto">{run.durationMs}ms</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <CollectionRunDetail run={detailRun} onClose={() => setDetailRun(null)} />

      {/* Load tests */}
      <section>
        <SectionHeader
          icon={<Gauge className="h-3 w-3" />}
          title="Load tests"
          right={
            runs.length > 0 ? (
              <button
                type="button"
                onClick={clearRuns}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted transition-colors"
              >
                <Trash2 className="h-3 w-3" /> Clear
              </button>
            ) : undefined
          }
        />
        {runs.length === 0 ? (
          <p className="text-[11px] text-sp-muted font-mono leading-relaxed">
            No runs yet. Run one from an HTTP request (⌘K &rarr; &ldquo;Run load test&rdquo;).
          </p>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <div
                key={run.id}
                className="rounded-md border border-border/50 bg-muted/20 p-2 space-y-1.5"
              >
                <div className="flex items-center gap-2">
                  <MethodBadge method={run.method} />
                  <span
                    className="font-mono text-[11px] text-foreground truncate flex-1"
                    title={run.url}
                  >
                    {run.url}
                  </span>
                  <button
                    type="button"
                    onClick={() => rerun(run.request)}
                    aria-label="Re-run load test"
                    className="shrink-0 inline-flex items-center justify-center size-5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    <RotateCw className="h-3 w-3" />
                  </button>
                </div>
                <div className="grid grid-cols-4 gap-1 font-mono text-[10px] text-muted-foreground tabular-nums">
                  <span title="requests/sec">{run.rps.toFixed(0)} rps</span>
                  <span title="p50 latency">p50 {run.stats.p50.toFixed(0)}</span>
                  <span title="p95 latency">p95 {run.stats.p95.toFixed(0)}</span>
                  <span title="p99 latency">p99 {run.stats.p99.toFixed(0)}</span>
                </div>
                <div className="flex items-center justify-between font-mono text-[10px] text-sp-muted">
                  <span>
                    {run.stats.count} reqs
                    {run.stats.errors > 0 && (
                      <span className="text-amber-500"> · {run.stats.errors} err</span>
                    )}
                  </span>
                  <span>{formatRelativeTime(run.completedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default RunsPanel;
