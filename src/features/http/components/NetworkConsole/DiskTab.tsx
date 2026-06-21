'use client';

import { useCallback, useEffect, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { HardDrive, RefreshCw, Trash2, ExternalLink, RotateCw, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/shared/utils';
import { getElectronAPI } from '@/lib/shared/platform';
import { useRequestStore } from '@/store/useRequestStore';
import { useActiveTab } from '@/store/selectors';
import { diskEntryToHttpRequest } from '@/store/useConsoleStore';
import {
  formatLongTimestamp,
  getMethodColor,
  getStatusTextColor,
} from '@/lib/shared/console-format';

interface DiskLogEntry {
  ts: number;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  protocol: 'http' | 'grpc';
  error?: string;
}

const PAGE_SIZE = 50;

export default function DiskTab() {
  const [entries, setEntries] = useState<DiskLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<DiskLogEntry | null>(null);
  const openTab = useRequestStore((s) => s.openTab);
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const activeTab = useActiveTab();

  const reload = useCallback(async () => {
    const api = getElectronAPI();
    if (!api) return;
    setLoading(true);
    try {
      const data = await api.log.getHistory(pageSize);
      // Reversed so most recent appears first — disk file is append-only.
      setEntries([...data].reverse());
    } catch (err) {
      console.error('Failed to load disk log:', err);
      toast.error('Could not load disk log');
    } finally {
      setLoading(false);
    }
  }, [pageSize]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleClear = async () => {
    const api = getElectronAPI();
    if (!api) return;
    await api.log.clear();
    setEntries([]);
    setSelected(null);
    toast.success('Disk log cleared');
  };

  const handleReplay = (entry: DiskLogEntry) => {
    if (entry.protocol !== 'http') {
      toast.error('Replay supports HTTP entries only');
      return;
    }
    const req = diskEntryToHttpRequest(entry.method, entry.url);
    if (activeTab?.request.type === 'http') {
      updateRequest({
        method: req.method,
        url: req.url,
        headers: req.headers,
        params: req.params,
        body: req.body,
        auth: req.auth,
      });
      toast.success('Replayed in active tab');
    } else {
      openTab(req, { switchTo: true });
      toast.success('Opened in a new tab');
    }
  };

  const handleOpenInNewTab = (entry: DiskLogEntry) => {
    if (entry.protocol !== 'http') {
      toast.error('Only HTTP entries can be opened in a new tab');
      return;
    }
    openTab(diskEntryToHttpRequest(entry.method, entry.url), { switchTo: true });
    toast.success('Opened in a new tab');
  };

  const handleCopyUrl = async (entry: DiskLogEntry) => {
    try {
      await navigator.clipboard.writeText(entry.url);
      toast.success('URL copied');
    } catch {
      toast.error('Failed to copy');
    }
  };

  if (loading && entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-8">
        <RefreshCw className="h-6 w-6 mb-3 animate-spin opacity-60" />
        <p className="text-xs">Loading disk log…</p>
      </div>
    );
  }

  if (!loading && entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-8 px-4 text-center">
        <HardDrive className="h-10 w-10 mb-3 opacity-30" />
        <p className="font-medium text-sm">Disk log is empty</p>
        <p className="text-xs mt-1">
          HTTP and gRPC requests sent from this desktop install are appended to{' '}
          <code className="px-1 rounded bg-muted">requests.jsonl</code> and shown here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="w-[320px] border-r border-border flex-shrink-0 flex flex-col">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <HardDrive className="h-3 w-3" />
            <span>Disk · last {entries.length}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={reload}
              className="h-6 w-6"
              title="Reload disk log"
            >
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleClear}
              className="h-6 w-6"
              title="Clear disk log file"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
        <ScrollArea className="flex-1">
          {entries.map((entry, idx) => {
            const isSelected = selected?.ts === entry.ts && selected.url === entry.url;
            const mc = getMethodColor(entry.method);
            return (
              <div
                key={`${entry.ts}-${idx}`}
                onClick={() => setSelected(entry)}
                className={cn(
                  'px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-accent/50 transition-colors',
                  isSelected && 'bg-accent'
                )}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <Badge
                    variant="outline"
                    className={cn('text-[10px] px-1.5 py-0 font-semibold', mc)}
                  >
                    {entry.method}
                  </Badge>
                  <span
                    className={cn(
                      'text-xs font-medium tabular-nums',
                      getStatusTextColor(entry.status)
                    )}
                  >
                    {entry.status || 'ERR'}
                  </span>
                  {entry.protocol !== 'http' && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase">
                      {entry.protocol}
                    </Badge>
                  )}
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {formatLongTimestamp(entry.ts)}
                  </span>
                </div>
                <div className="text-xs text-foreground/80 truncate font-mono">{entry.url}</div>
                <div className="text-[10px] text-muted-foreground">{entry.durationMs}ms</div>
              </div>
            );
          })}
          {entries.length >= pageSize && (
            <button
              type="button"
              className="w-full text-center text-[11px] text-primary py-2 hover:bg-accent/50"
              onClick={() => setPageSize((n) => n + PAGE_SIZE)}
            >
              Load more
            </button>
          )}
        </ScrollArea>
      </div>

      {/* Detail */}
      <div className="flex-1 min-w-0 p-4">
        {selected ? (
          <div className="space-y-3 text-xs">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] px-1.5 py-0 font-semibold',
                  getMethodColor(selected.method)
                )}
              >
                {selected.method}
              </Badge>
              <span className={cn('font-medium tabular-nums', getStatusTextColor(selected.status))}>
                {selected.status || 'ERR'}
              </span>
              <span className="text-muted-foreground">{selected.durationMs}ms</span>
              <span className="text-muted-foreground ml-auto">
                {formatLongTimestamp(selected.ts)}
              </span>
            </div>
            <div className="font-mono break-all bg-muted/40 rounded p-2">{selected.url}</div>
            {selected.error && (
              <div className="text-red-500 bg-red-500/5 border border-red-500/20 rounded p-2 font-mono">
                {selected.error}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => handleReplay(selected)}
              >
                <RotateCw className="h-3 w-3 mr-1" />
                Replay
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => handleOpenInNewTab(selected)}
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Open in new tab
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => handleCopyUrl(selected)}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy URL
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Disk entries record metadata only (method, URL, status, timing) — no headers or
              bodies.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <HardDrive className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-xs">Select an entry to view metadata and replay it</p>
          </div>
        )}
      </div>
    </div>
  );
}
