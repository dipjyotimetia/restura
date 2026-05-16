'use client';

import { useMemo, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Cable,
  Copy,
  Info,
  Search,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/shared/utils';
import {
  useConsoleStore,
  type ConsoleFrame,
  type FrameProtocol,
} from '@/store/useConsoleStore';
import { formatBytes, formatClockTime } from '@/lib/shared/console-format';

const PROTOCOL_FILTERS: Array<{ value: FrameProtocol | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'websocket', label: 'WS' },
  { value: 'socketio', label: 'Socket.IO' },
  { value: 'kafka', label: 'Kafka' },
];

const frameBytes = (frame: ConsoleFrame): number =>
  frame.bytes ?? (frame.payload ? new Blob([frame.payload]).size : 0);

function directionIcon(direction: ConsoleFrame['direction']) {
  if (direction === 'in') return <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-500" />;
  if (direction === 'out') return <ArrowUpRight className="h-3.5 w-3.5 text-blue-500" />;
  return <Info className="h-3.5 w-3.5 text-muted-foreground" />;
}

function directionColor(direction: ConsoleFrame['direction']) {
  if (direction === 'in') return 'text-emerald-600 dark:text-emerald-400';
  if (direction === 'out') return 'text-blue-600 dark:text-blue-400';
  return 'text-muted-foreground';
}

export default function FramesTab() {
  const { frames, clearFrames } = useConsoleStore();
  const [search, setSearch] = useState('');
  const [protocolFilter, setProtocolFilter] = useState<FrameProtocol | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return frames.filter((f) => {
      if (protocolFilter !== 'all' && f.protocol !== protocolFilter) return false;
      if (!q) return true;
      return (
        f.payload.toLowerCase().includes(q) ||
        (f.label ?? '').toLowerCase().includes(q) ||
        (f.connectionId ?? '').toLowerCase().includes(q)
      );
    });
  }, [frames, search, protocolFilter]);

  const selectedFrame = selectedId ? frames.find((f) => f.id === selectedId) : undefined;

  if (frames.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-8 px-4 text-center">
        <Cable className="h-10 w-10 mb-3 opacity-30" />
        <p className="font-medium text-sm">No frames yet</p>
        <p className="text-xs mt-1">
          WebSocket, Socket.IO, and Kafka messages appear here as they're sent or received.
        </p>
      </div>
    );
  }

  const handleCopy = async (frame: ConsoleFrame) => {
    try {
      await navigator.clipboard.writeText(frame.payload);
      toast.success('Frame copied');
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="w-[320px] border-r border-border flex-shrink-0 flex flex-col">
        <div className="p-2 border-b border-border space-y-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter frames..."
              className="h-7 pl-7 pr-7 text-xs"
            />
            {search && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6"
                onClick={() => setSearch('')}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1 items-center justify-between">
            <div className="flex flex-wrap gap-1">
              {PROTOCOL_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setProtocolFilter(f.value)}
                  className={cn(
                    'text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors',
                    protocolFilter === f.value
                      ? 'bg-primary/15 border-primary/40 text-primary'
                      : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60'
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="text-[10px] underline text-muted-foreground hover:text-foreground"
              onClick={() => {
                clearFrames();
                setSelectedId(null);
              }}
            >
              Clear
            </button>
          </div>
        </div>
        <ScrollArea className="flex-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-center px-4">
              <Search className="h-5 w-5 mb-2 opacity-30" />
              <p className="text-[11px]">No matching frames</p>
            </div>
          ) : (
            filtered.map((frame) => {
              const isSelected = frame.id === selectedId;
              const preview =
                frame.payload.length > 80
                  ? frame.payload.slice(0, 80) + '…'
                  : frame.payload;
              return (
                <div
                  key={frame.id}
                  onClick={() => setSelectedId(frame.id)}
                  className={cn(
                    'px-3 py-1.5 cursor-pointer border-b border-border/50 hover:bg-accent/50 transition-colors',
                    isSelected && 'bg-accent'
                  )}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    {directionIcon(frame.direction)}
                    <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase">
                      {frame.protocol === 'socketio' ? 'SIO' : frame.protocol === 'websocket' ? 'WS' : 'KAFKA'}
                    </Badge>
                    {frame.label && (
                      <span className="text-[11px] font-mono text-foreground/80 truncate max-w-[120px]">
                        {frame.label}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                      {formatClockTime(frame.timestamp)}
                    </span>
                  </div>
                  <div
                    className={cn(
                      'text-[11px] font-mono truncate',
                      directionColor(frame.direction)
                    )}
                  >
                    {preview || <span className="text-muted-foreground">(empty)</span>}
                  </div>
                </div>
              );
            })
          )}
        </ScrollArea>
      </div>

      {/* Detail */}
      <div className="flex-1 min-w-0">
        {selectedFrame ? (
          <div className="h-full flex flex-col">
            <div className="px-4 py-2 border-b border-border flex items-center gap-2 text-xs">
              {directionIcon(selectedFrame.direction)}
              <span className="font-semibold uppercase">{selectedFrame.protocol}</span>
              {selectedFrame.label && (
                <span className="font-mono text-muted-foreground">{selectedFrame.label}</span>
              )}
              <span className="text-muted-foreground ml-2">
                {formatClockTime(selectedFrame.timestamp)}
              </span>
              <span className="text-muted-foreground">
                {formatBytes(frameBytes(selectedFrame))}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] ml-auto"
                onClick={() => handleCopy(selectedFrame)}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </Button>
            </div>
            <ScrollArea className="flex-1">
              <pre className="p-4 text-[11px] font-mono whitespace-pre-wrap wrap-break-word leading-relaxed">
                {selectedFrame.payload || <span className="text-muted-foreground">(empty payload)</span>}
              </pre>
              {selectedFrame.connectionId && (
                <div className="px-4 pb-4 text-[10px] text-muted-foreground font-mono">
                  connection: {selectedFrame.connectionId}
                </div>
              )}
            </ScrollArea>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Cable className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-xs">Select a frame to view its payload</p>
          </div>
        )}
      </div>
    </div>
  );
}
