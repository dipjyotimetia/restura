import {
  pingPayloadError,
  utf8ByteLength,
  WS_MAX_PING_PAYLOAD_BYTES,
} from '@shared/protocol/websocket-control';
import { Activity, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WEB_PING_UNSUPPORTED } from '@/features/websocket/lib/wsControlFrames';
import { isElectron } from '@/lib/shared/platform';

interface WsPingControlProps {
  /** Ping can only be sent on an open connection. */
  disabled: boolean;
  onPing: (payload: string) => void;
}

const SEGMENT =
  'inline-flex items-center gap-1 h-7 font-medium text-sp-12 border border-sp-line text-sp-muted bg-transparent transition-colors hover:bg-sp-hover hover:text-sp-text disabled:opacity-50 disabled:hover:bg-transparent';

/**
 * Split "Ping" button (#919). Desktop sends a Ping control frame (optional
 * ≤125-byte payload) over IPC; pongs land in the transcript with RTT. The
 * browser WebSocket API exposes no ping/pong, so on web the control is shown
 * disabled with an explanatory tooltip.
 */
export function WsPingControl({ disabled, onPing }: WsPingControlProps) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState('');

  if (!isElectron()) {
    return (
      <span title={WEB_PING_UNSUPPORTED} className="inline-flex" data-testid="ws-ping-web">
        <button
          type="button"
          disabled
          aria-label="Send ping (desktop only)"
          className={`${SEGMENT} px-2.5 rounded-sp-btn pointer-events-none`}
        >
          <Activity className="h-3.5 w-3.5" /> Ping
        </button>
      </span>
    );
  }

  const error = pingPayloadError(payload);
  const submit = () => {
    if (error) return;
    setOpen(false);
    onPing(payload);
  };

  return (
    <div className="inline-flex">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPing('')}
        title="Send a WebSocket ping control frame"
        className={`${SEGMENT} px-2.5 rounded-l-sp-btn`}
      >
        <Activity className="h-3.5 w-3.5" /> Ping
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Ping with payload"
            title="Send a ping with a payload"
            className={`${SEGMENT} px-1.5 -ml-px rounded-r-sp-btn`}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-3">
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label htmlFor="ws-ping-payload" className="text-sp-12 font-medium text-sp-text">
              Ping payload (optional)
            </label>
            <Input
              id="ws-ping-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder="echoed back in the pong"
              className="h-7 font-mono text-sp-12"
            />
            <div className="flex items-center gap-2 text-sp-11">
              <span
                className={error ? 'text-danger' : 'text-sp-dim'}
                role={error ? 'alert' : undefined}
              >
                {error ?? 'UTF-8 text, echoed in the pong.'}
              </span>
              <span className="flex-1" />
              <span className="font-mono tabular-nums text-sp-dim">
                {utf8ByteLength(payload)}/{WS_MAX_PING_PAYLOAD_BYTES} B
              </span>
            </div>
            <button
              type="submit"
              disabled={error !== null}
              className={`${SEGMENT} justify-center rounded-sp-btn`}
            >
              Send ping
            </button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}
