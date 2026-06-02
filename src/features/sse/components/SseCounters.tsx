import { Floater, Stat } from '@/components/ui/spatial';

export interface SseCountersProps {
  events: number;
  bytes: number;
  tokens: number;
  reconnects: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Right column bottom — 2x2 grid of stat tiles.
 */
export function SseCounters({ events, bytes, tokens, reconnects }: SseCountersProps) {
  return (
    <Floater radius="panel" elevation="float" className="flex flex-col overflow-hidden shrink-0">
      <div className="flex items-center justify-between px-4 h-11 border-b border-sp-line shrink-0">
        <span className="sp-label">Counters</span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 p-3">
        <div className="p-3 rounded-sp-btn border border-sp-line bg-sp-surface-lo/60">
          <Stat label="Events" value={events.toLocaleString()} />
        </div>
        <div className="p-3 rounded-sp-btn border border-sp-line bg-sp-surface-lo/60">
          <Stat label="Bytes" value={formatBytes(bytes)} />
        </div>
        <div className="p-3 rounded-sp-btn border border-sp-line bg-sp-surface-lo/60">
          <Stat label="Tokens" value={tokens.toLocaleString()} />
        </div>
        <div className="p-3 rounded-sp-btn border border-sp-line bg-sp-surface-lo/60">
          <Stat label="Reconnects" value={reconnects.toLocaleString()} />
        </div>
      </div>
    </Floater>
  );
}

export default SseCounters;
