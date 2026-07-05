import { Stat } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';

export interface SseStatsRowProps {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  events: number;
  lastEventId: string | undefined;
  avgGapMs: number | null;
  reconnects: number;
}

/**
 * Stats strip below the URL bar. STREAMING (green dot pulses) | EVENTS |
 * LAST-EVENT-ID | AVG GAP | RECONNECT. Stream/Stop control lives in the
 * URL bar only — no duplicate Stop here.
 */
export function SseStatsRow({
  status,
  events,
  lastEventId,
  avgGapMs,
  reconnects,
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
      ? 'var(--color-success)'
      : status === 'connecting' || status === 'reconnecting'
        ? 'var(--color-warning)'
        : 'var(--color-neutral)';

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
              boxShadow: `0 0 8px color-mix(in srgb, ${statusColor} 53%, transparent)`,
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
    </div>
  );
}

export default SseStatsRow;
