import { Square } from 'lucide-react';
import { Stat } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';

export interface SseStatsRowProps {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  events: number;
  lastEventId: string | undefined;
  avgGapMs: number | null;
  reconnects: number;
  onStop: () => void;
  canStop: boolean;
}

/**
 * Stats strip below the URL bar. STREAMING (green dot pulses) | EVENTS |
 * LAST-EVENT-ID | AVG GAP | RECONNECT + a destructive Stop button on the right.
 */
export function SseStatsRow({
  status,
  events,
  lastEventId,
  avgGapMs,
  reconnects,
  onStop,
  canStop,
}: SseStatsRowProps) {
  const streamingLabel =
    status === 'connected'
      ? 'STREAMING'
      : status === 'connecting'
        ? 'CONNECTING'
        : status === 'reconnecting'
          ? 'RECONNECTING'
          : 'IDLE';

  const statusColor =
    status === 'connected'
      ? '#22c55e'
      : status === 'connecting' || status === 'reconnecting'
        ? '#f59e0b'
        : '#94a3b8';

  return (
    <div className="flex items-center gap-6 px-4 py-2.5 border-b border-sp-line bg-sp-surface-lo/40">
      <div className="flex flex-col gap-0.5">
        <span className="sp-label">Status</span>
        <span
          className="font-mono font-semibold text-sp-12 tabular-nums inline-flex items-center gap-1.5"
          style={{ color: statusColor }}
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-1.5 w-1.5 rounded-full inline-block',
              status === 'connected' && 'animate-pulse'
            )}
            style={{
              background: statusColor,
              boxShadow: `0 0 8px ${statusColor}88`,
            }}
          />
          {streamingLabel}
        </span>
      </div>

      <Stat label="Events" value={events.toLocaleString()} />
      <Stat
        label="Last-Event-ID"
        value={lastEventId ? lastEventId : <span className="text-sp-dim">—</span>}
      />
      <Stat
        label="Avg Gap"
        value={
          avgGapMs == null ? <span className="text-sp-dim">—</span> : `${avgGapMs.toFixed(0)}ms`
        }
      />
      <Stat label="Reconnect" value={reconnects.toString()} />

      <div className="ml-auto">
        <button
          type="button"
          onClick={onStop}
          disabled={!canStop}
          aria-label="Stop SSE stream"
          className={cn(
            'h-8 px-3 rounded-sp-btn text-sp-12 font-semibold inline-flex items-center gap-1.5',
            'border border-[rgba(239,68,68,0.40)] text-[#ef4444] bg-transparent',
            'enabled:hover:bg-[rgba(239,68,68,0.10)] transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          <Square className="h-3.5 w-3.5" />
          Stop
        </button>
      </div>
    </div>
  );
}

export default SseStatsRow;
