import {
  closeFrameError,
  utf8ByteLength,
  WS_DEFAULT_CLOSE_CODE,
  WS_MAX_CLOSE_REASON_BYTES,
} from '@shared/protocol/websocket-control';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { WsCloseOptions } from '@/features/websocket/lib/wsControlFrames';

interface WsDisconnectControlProps {
  /** Called with no argument for the default close, or with the chosen close frame. */
  onDisconnect: (close?: WsCloseOptions) => void;
}

const SEGMENT =
  'inline-flex items-center h-7 font-medium text-sp-12 border border-danger/35 text-danger bg-transparent transition-colors hover:bg-danger/10';

/**
 * Split "Disconnect" button (#915): the main segment closes with the default
 * 1000; the chevron opens a form for a custom RFC 6455 close code + reason.
 */
export function WsDisconnectControl({ onDisconnect }: WsDisconnectControlProps) {
  const [open, setOpen] = useState(false);
  const [codeText, setCodeText] = useState(String(WS_DEFAULT_CLOSE_CODE));
  const [reason, setReason] = useState('');

  const code = codeText.trim() === '' ? Number.NaN : Number(codeText);
  const error = closeFrameError(code, reason);
  const reasonBytes = utf8ByteLength(reason);

  const submit = () => {
    if (error) return;
    setOpen(false);
    onDisconnect({ code, ...(reason ? { reason } : {}) });
  };

  return (
    <div className="inline-flex">
      <button
        type="button"
        onClick={() => onDisconnect()}
        className={`${SEGMENT} px-3 rounded-l-sp-btn`}
      >
        Disconnect
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Disconnect with close code"
            title="Disconnect with a custom close code and reason"
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
            <span className="text-sp-12 font-medium text-sp-text">Close frame</span>
            <label htmlFor="ws-close-code" className="text-sp-11 text-sp-muted">
              Code (1000 or 3000-4999)
            </label>
            <Input
              id="ws-close-code"
              inputMode="numeric"
              value={codeText}
              onChange={(e) => setCodeText(e.target.value)}
              className="h-7 font-mono text-sp-12"
            />
            <label htmlFor="ws-close-reason" className="text-sp-11 text-sp-muted">
              Reason (optional)
            </label>
            <Input
              id="ws-close-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. test complete"
              className="h-7 font-mono text-sp-12"
            />
            <div className="flex items-center gap-2 text-sp-11">
              <span
                className={error ? 'text-danger' : 'text-sp-dim'}
                role={error ? 'alert' : undefined}
              >
                {error ?? 'Sent in the close frame to the server.'}
              </span>
              <span className="flex-1" />
              <span className="font-mono tabular-nums text-sp-dim">
                {reasonBytes}/{WS_MAX_CLOSE_REASON_BYTES} B
              </span>
            </div>
            <button
              type="submit"
              disabled={error !== null}
              className={`${SEGMENT} justify-center rounded-sp-btn disabled:opacity-50`}
            >
              Close with code
            </button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}
