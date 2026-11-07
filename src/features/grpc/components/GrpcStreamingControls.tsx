'use client';

import type { DescMessage } from '@bufbuild/protobuf';
import { parseGrpcMessageJson } from '@shared/protocol/grpc-json';
import { useId, useMemo, useRef, useState } from 'react';
import {
  MessageLogToolbar,
  useFrozenView,
} from '@/components/shared/messageLog/MessageLogControls';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { filteredEmptyText, filterLog, type LogDirection } from '@/lib/shared/messageLog';
import type { GrpcMethodType } from '@/types';

interface StreamControl {
  sendMessage: (msg: unknown) => void;
  endStream: () => void;
  cancelStream: () => void;
  /** Input schema for 64-bit-precise parsing of typed messages (parseGrpcMessageJson). */
  inputSchema?: () => DescMessage | undefined;
}

interface GrpcStreamingControlsProps {
  streamControl: StreamControl | null;
  methodType: GrpcMethodType;
  onCancel: () => void;
}

export default function GrpcStreamingControls({
  streamControl,
  methodType,
  onCancel,
}: GrpcStreamingControlsProps) {
  const [messageInput, setMessageInput] = useState('{}');
  const [sendError, setSendError] = useState<string | null>(null);
  const errorId = useId();

  if (!streamControl) return null;

  const canSendMessages =
    methodType === 'client-streaming' || methodType === 'bidirectional-streaming';

  const handleSend = () => {
    setSendError(null);
    try {
      const parsed = parseGrpcMessageJson(messageInput, streamControl.inputSchema);
      streamControl.sendMessage(parsed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setSendError(`Invalid JSON — message not sent: ${detail}`);
    }
  };

  const handleEnd = () => {
    streamControl.endStream();
  };

  return (
    <div className="flex items-center gap-2">
      {canSendMessages && (
        <div className="flex items-center gap-1">
          <Textarea
            value={messageInput}
            onChange={(e) => {
              setMessageInput(e.target.value);
              setSendError(null);
            }}
            placeholder="{}"
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter sends this message instead of re-invoking.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSend();
              }
            }}
            className={`h-7 min-w-[180px] max-w-[260px] resize-none font-mono text-xs py-1 ${sendError ? 'border-destructive' : ''}`}
            rows={1}
            aria-label="Stream message JSON"
            aria-invalid={sendError ? true : undefined}
            aria-describedby={sendError ? errorId : undefined}
            title="JSON message to send (Cmd/Ctrl+Enter)"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleSend}
            className="h-7 shrink-0 font-mono text-xs"
            title="Send message to stream"
          >
            Send
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleEnd}
            className="h-7 shrink-0 font-mono text-xs"
            title="End client stream (sends EOF)"
          >
            End
          </Button>
          {sendError && (
            <span
              id={errorId}
              role="alert"
              className="text-sp-11 font-mono text-destructive max-w-[260px] truncate"
              title={sendError}
            >
              {sendError}
            </span>
          )}
        </div>
      )}
      <Button
        variant="destructive"
        size="sm"
        onClick={onCancel}
        className="h-7 shrink-0"
        aria-label="Cancel stream"
      >
        Cancel
      </Button>
    </div>
  );
}

const RECEIVED_ONLY: ReadonlyArray<LogDirection> = ['in'];

// Component for displaying streaming messages
export function GrpcStreamingMessages({
  messages,
  dropped = 0,
  positions,
  exportName = 'grpc-stream',
  exportMeta,
  onClear,
}: {
  messages: string[];
  /** Messages evicted or skipped (oversized) by the renderer's retention bound. */
  dropped?: number;
  /** Original 1-based stream position per message; defaults to a contiguous tail. */
  positions?: number[];
  exportName?: string;
  exportMeta?: Record<string, unknown>;
  onClear?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState<LogDirection | 'all'>('all');
  const [frozen, setFrozen] = useState(false);
  // The log carries no receipt times; stamp each position when first seen so
  // the freeze cutoff (a wall-clock time) works.
  const seenAt = useRef(new Map<number, number>());
  const entries = useMemo(() => {
    // A new invocation restarts numbering at 1 — forget the old stamps.
    if (messages.length === 0) seenAt.current.clear();
    return messages.map((body, index) => {
      const position = positions?.[index] ?? dropped + index + 1;
      let timestamp = seenAt.current.get(position);
      if (timestamp === undefined) {
        timestamp = Date.now();
        seenAt.current.set(position, timestamp);
      }
      return {
        id: String(position),
        position,
        timestamp,
        direction: 'in' as const,
        body,
      };
    });
  }, [messages, positions, dropped]);
  const filtered = useMemo(
    () => filterLog(entries, { query, direction }),
    [entries, query, direction]
  );
  const { visible, newCount } = useFrozenView(filtered, frozen);
  if (messages.length === 0 && dropped === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-sm text-muted-foreground mb-2">
        Streaming messages received: {messages.length + dropped}
      </div>
      <div className="-mx-3">
        <MessageLogToolbar
          query={query}
          onQueryChange={setQuery}
          direction={direction}
          onDirectionChange={setDirection}
          directions={RECEIVED_ONLY}
          frozen={frozen}
          newCount={newCount}
          onFrozenChange={setFrozen}
          exportEntries={() => filtered}
          exportName={exportName}
          {...(exportMeta ? { exportMeta } : {})}
          onClear={() => onClear?.()}
          hasEntries={!!onClear && messages.length > 0}
        />
      </div>
      {dropped > 0 && <StreamDroppedNotice dropped={dropped} />}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {messages.length > 0 && visible.length === 0 && (
          <div className="text-xs text-muted-foreground italic">
            {filteredEmptyText('message', newCount)}
          </div>
        )}
        {visible.map((entry) => (
          <div key={entry.position} className="bg-muted p-2 rounded border border-border">
            <div className="text-xs font-medium mb-1">Message {entry.position}</div>
            <pre className="text-xs whitespace-pre-wrap">{entry.body}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/** "N messages dropped" — shown when the retained window evicted or skipped messages. */
export function StreamDroppedNotice({ dropped }: { dropped: number }) {
  return (
    <div
      role="status"
      className="text-xs text-muted-foreground border border-border rounded px-2 py-1"
    >
      {dropped.toLocaleString()} {dropped === 1 ? 'message' : 'messages'} dropped — only the most
      recent are kept to bound memory.
    </div>
  );
}
