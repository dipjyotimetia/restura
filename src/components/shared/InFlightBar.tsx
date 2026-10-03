import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatTime } from '@/lib/shared/utils';
import { useActiveTab } from '@/store/selectors';
import { useUiStore } from '@/store/useUiStore';

/**
 * Elapsed time and Cancel for the request in flight on the visible tab. Its
 * own component so the 100ms tick doesn't re-render the response viewer.
 */
export function InFlightBar() {
  const inFlight = useUiStore((s) => s.inFlight);
  const activeTabId = useActiveTab()?.id;
  const [now, setNow] = useState(() => Date.now());
  const visible = inFlight !== null && inFlight.tabId === activeTabId;

  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible || !inFlight) return null;
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-sp-line bg-sp-surface text-sp-12">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-sp-accent" aria-hidden="true" />
      <span className="text-sp-muted">
        Waiting for response…{' '}
        <span className="font-mono tabular-nums text-sp-text">
          {formatTime(Math.max(0, now - inFlight.startedAt))}
        </span>
      </span>
      <button
        type="button"
        onClick={inFlight.cancel}
        className="ml-auto rounded-sp-btn border border-sp-line px-2.5 py-1 text-sp-12 text-sp-text hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
      >
        Cancel
      </button>
    </div>
  );
}
