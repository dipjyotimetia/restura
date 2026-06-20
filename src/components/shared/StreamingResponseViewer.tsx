'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { HttpStreamEvent } from '@/features/http/lib/streamingResponseReader';
import { WindowedList, type WindowedListHandle } from './lib/windowedList';
import { Button } from '@/components/ui/button';
import { Pause, Play, ArrowDown } from 'lucide-react';

export interface StreamingResponseViewerProps {
  events: AsyncIterable<HttpStreamEvent>;
  /** Maximum events kept in the rendered window. Older events are dropped. Default 5000. */
  maxRetained?: number;
}

const ITEM_HEIGHT = 36;
const VIEWPORT_HEIGHT = 480;

export function StreamingResponseViewer(props: StreamingResponseViewerProps) {
  const { events, maxRetained = 5000 } = props;

  const [rendered, setRendered] = useState<HttpStreamEvent[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [status, setStatus] = useState<'streaming' | 'closed' | 'error'>('streaming');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const bufferedRef = useRef<HttpStreamEvent[]>([]);
  const pausedRef = useRef(false);
  const listRef = useRef<WindowedListHandle>(null);
  const [showJumpPill, setShowJumpPill] = useState(false);
  const [bufferedCount, setBufferedCount] = useState(0);

  pausedRef.current = paused;

  const append = useCallback(
    (event: HttpStreamEvent) => {
      if (
        pausedRef.current &&
        (event.type === 'sse' || event.type === 'ndjson' || event.type === 'raw')
      ) {
        bufferedRef.current.push(event);
        setBufferedCount(bufferedRef.current.length);
        return;
      }
      setRendered((prev) => {
        const next = prev.concat(event);
        return next.length > maxRetained ? next.slice(next.length - maxRetained) : next;
      });
    },
    [maxRetained]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        for await (const event of events) {
          if (cancelled) break;
          if (event.type === 'sse' || event.type === 'ndjson' || event.type === 'raw') {
            setTotalCount((c) => c + 1);
          }
          if (event.type === 'end') {
            setStatus('closed');
            setTotalBytes(event.bytesRead);
            append(event);
          } else if (event.type === 'error') {
            setStatus('error');
            setErrorMessage(event.error);
            setTotalBytes(event.bytesRead);
            // do not append error rows inline — the dedicated footer renders the message
          } else {
            append(event);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorMessage(err instanceof Error ? err.message : 'Stream failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [events, append]);

  // Auto-scroll when new events arrive, unless user has scrolled up
  useEffect(() => {
    if (listRef.current?.isAtBottom() ?? true) {
      requestAnimationFrame(() => listRef.current?.scrollToBottom());
      setShowJumpPill(false);
    } else {
      setShowJumpPill(true);
    }
  }, [rendered.length]);

  const onScroll = useCallback(() => {
    if (listRef.current?.isAtBottom()) setShowJumpPill(false);
  }, []);

  const togglePause = useCallback(() => {
    if (paused) {
      // Resume — drain buffered events
      const drained = bufferedRef.current;
      bufferedRef.current = [];
      setBufferedCount(0);
      setRendered((prev) => {
        const merged = prev.concat(drained);
        return merged.length > maxRetained ? merged.slice(merged.length - maxRetained) : merged;
      });
      setPaused(false);
    } else {
      setPaused(true);
    }
  }, [paused, maxRetained]);

  const jumpToLatest = useCallback(() => {
    listRef.current?.scrollToBottom();
    setShowJumpPill(false);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 border-b px-3 py-2 text-sm">
        <span
          className={[
            'flex items-center gap-1.5',
            status === 'streaming'
              ? 'text-green-600'
              : status === 'error'
                ? 'text-red-600'
                : 'text-muted-foreground',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block size-2 rounded-full',
              status === 'streaming'
                ? 'bg-green-500 animate-pulse'
                : status === 'error'
                  ? 'bg-red-500'
                  : 'bg-muted-foreground',
            ].join(' ')}
          />
          {status === 'streaming' ? 'Streaming' : status === 'error' ? 'Error' : 'Ended'}
        </span>
        <span className="text-muted-foreground">{totalCount} events</span>
        <span className="text-muted-foreground">{totalBytes} bytes</span>
        <div className="flex-1" />
        {(status === 'streaming' || bufferedCount > 0) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={togglePause}
            aria-label={paused ? 'resume' : 'pause'}
          >
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            <span className="ml-1">{paused ? 'Resume' : 'Pause'}</span>
          </Button>
        )}
      </div>

      <div className="flex-1 relative">
        <WindowedList<HttpStreamEvent>
          ref={listRef}
          items={rendered}
          itemHeight={ITEM_HEIGHT}
          height={VIEWPORT_HEIGHT}
          onScroll={onScroll}
          renderItem={(event, index) => <HttpStreamEventRow key={index} event={event} />}
        />
        {showJumpPill && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute right-3 bottom-3 flex items-center gap-1 rounded-full bg-foreground/80 text-background px-3 py-1 text-xs shadow-lg"
          >
            <ArrowDown className="size-3" /> Jump to latest
          </button>
        )}
      </div>

      {errorMessage && (
        <div className="border-t px-3 py-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/30">
          {errorMessage}
        </div>
      )}
    </div>
  );
}

function HttpStreamEventRow({ event }: { event: HttpStreamEvent }) {
  if (event.type === 'sse') {
    const e = event.payload;
    return (
      <div className="flex items-baseline gap-2 px-3 py-1.5 text-sm border-b border-border/30">
        <span className="text-xs font-mono opacity-60">{e.event ?? 'message'}</span>
        {e.id && <span className="text-xs font-mono opacity-40">#{e.id}</span>}
        <span className="truncate font-mono text-xs">{e.data}</span>
      </div>
    );
  }
  if (event.type === 'ndjson') {
    return (
      <div className="px-3 py-1.5 text-sm border-b border-border/30 font-mono text-xs truncate">
        {JSON.stringify(event.payload)}
      </div>
    );
  }
  if (event.type === 'raw') {
    return (
      <div className="px-3 py-1.5 text-sm border-b border-border/30 font-mono text-xs whitespace-pre-wrap">
        {event.payload}
      </div>
    );
  }
  if (event.type === 'end') {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground italic border-b border-border/30">
        ▾ Stream ended ({event.bytesRead} B in {event.durationMs}ms)
      </div>
    );
  }
  // error type — also rendered in the error footer; but show inline for context
  return (
    <div className="px-3 py-2 text-xs text-red-600 border-b border-border/30">
      Error: {event.error}
    </div>
  );
}
