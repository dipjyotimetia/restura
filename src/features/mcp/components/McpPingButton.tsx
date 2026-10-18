import { Activity } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** `ping` action; shows the measured round-trip time (or the failure). */
export function McpPingButton({
  onPing,
}: {
  onPing: () => Promise<{ ok: boolean; durationMs: number; error?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const handlePing = async () => {
    setBusy(true);
    try {
      const res = await onPing();
      setOutcome(
        res.ok
          ? { ok: true, text: `${Math.round(res.durationMs)} ms` }
          : { ok: false, text: res.error ?? 'Ping failed' }
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        onClick={handlePing}
        loading={busy}
        className="h-6 px-2 text-sp-11 rounded-sp-btn"
      >
        <Activity className="h-3 w-3" />
        Ping
      </Button>
      {outcome && (
        <span
          role="status"
          aria-label="Ping result"
          className="font-mono text-sp-11 tabular-nums"
          style={{ color: outcome.ok ? 'var(--color-success)' : 'var(--color-danger)' }}
        >
          {outcome.text}
        </span>
      )}
    </span>
  );
}
