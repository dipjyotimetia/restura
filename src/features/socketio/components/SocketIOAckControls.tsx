import { Reply, SlidersHorizontal } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleField } from '@/components/ui/spatial';
import { replyAckWithVariables } from '@/features/socketio/lib/emitWithVariables';
import {
  type SocketIOEmitOptions,
  type SocketIOEvent,
  useSocketIOStore,
} from '@/features/socketio/store/useSocketIOStore';

/**
 * Reply box for a received event whose server emit requested an
 * acknowledgement (SIO-1). The args use the composer's JSON syntax, including
 * `{{variables}}` and `{ "$binary": "<base64>" }` attachments.
 */
export function SocketIOAckReply({
  connectionId,
  event,
  isConnected,
}: {
  connectionId: string;
  event: SocketIOEvent;
  isConnected: boolean;
}) {
  const [text, setText] = useState('"ok"');
  const [error, setError] = useState<string | null>(null);
  if (!event.serverAckId) return null;
  const serverAckId = event.serverAckId;

  if (event.serverAckReplied) {
    return (
      <div className="px-3 py-2 border-t border-sp-line text-sp-11 text-sp-muted shrink-0">
        Acknowledgement sent.
      </div>
    );
  }

  const send = () => {
    const out = replyAckWithVariables(connectionId, serverAckId, text);
    setError(out.ok ? null : out.error);
  };

  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2 border-t border-sp-line shrink-0"
      data-testid="socketio-ack-reply"
    >
      <span className="text-sp-11 font-medium" style={{ color: 'var(--color-warning)' }}>
        Server is waiting for an acknowledgement
      </span>
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
          disabled={!isConnected}
          placeholder='Ack args (JSON), e.g. "ok" or [{"status":"done"}]'
          aria-label="Acknowledgement arguments (JSON)"
          className="h-7 flex-1 bg-sp-surface-lo border border-sp-line px-2 font-mono text-sp-12 text-sp-text"
        />
        <Button variant="glow" size="sm" className="h-7" onClick={send} disabled={!isConnected}>
          <Reply className="h-3.5 w-3.5 mr-1" /> Send ack
        </Button>
      </div>
      {error && (
        <p className="font-mono text-sp-11" style={{ color: 'var(--color-danger)' }}>
          JSON error: {error}
        </p>
      )}
    </div>
  );
}

/** Per-emit modifiers (SIO-5): volatile, compress and ack timeout, stored per connection. */
export function SocketIOEmitOptionsMenu({
  connectionId,
  options,
}: {
  connectionId: string;
  options: SocketIOEmitOptions;
}) {
  const update = useSocketIOStore((s) => s.updateConnectionField);
  const timeoutId = useId();
  const set = (patch: Partial<SocketIOEmitOptions>) =>
    update(connectionId, 'emitOptions', { ...options, ...patch });
  const active = options.volatile || !options.compress;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Emit options"
          title="Emit options"
          className="relative inline-flex h-6 w-6 items-center justify-center rounded-sp-chip text-sp-muted hover:bg-sp-hover hover:text-sp-text"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {active && (
            <span
              aria-hidden="true"
              className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full"
              style={{ background: 'var(--color-warning)' }}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 flex flex-col gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sp-12 text-sp-text">Volatile</span>
          <ToggleField
            size="sm"
            checked={options.volatile}
            onChange={(v) => set({ volatile: v })}
            ariaLabel="Volatile emit"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sp-12 text-sp-text">Compress</span>
          <ToggleField
            size="sm"
            checked={options.compress}
            onChange={(v) => set({ compress: v })}
            ariaLabel="Compress emit"
          />
        </div>
        <label htmlFor={timeoutId} className="flex items-center justify-between gap-2">
          <span className="text-sp-12 text-sp-text">Ack timeout (ms)</span>
          <Input
            id={timeoutId}
            type="number"
            min={1}
            max={60_000}
            value={options.ackTimeoutMs}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (e.target.value === '' || !Number.isFinite(n)) return;
              set({ ackTimeoutMs: Math.min(60_000, Math.max(1, n)) });
            }}
            className="h-7 w-24 bg-sp-surface-lo border border-sp-line px-2 font-mono text-sp-12 text-sp-text"
          />
        </label>
        <p className="text-sp-11 text-sp-dim">
          Binary args: use <code>{'{"$binary":"<base64>"}'}</code> anywhere in the JSON.
        </p>
      </PopoverContent>
    </Popover>
  );
}
