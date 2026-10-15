import { useCallback, useState } from 'react';
import {
  appendRetained,
  emptyRetained,
  type RetainedMessages,
  retainedFrom,
} from '@/features/grpc/lib/streamRetention';

export interface StreamMessageLog {
  /** Retained messages (newest last). */
  messages: string[];
  /** Messages evicted or skipped (oversized) to keep the window bounded. */
  dropped: number;
  /** Original 1-based stream position of each retained message. */
  positions: number[];
  append: (text: string) => void;
  reset: () => void;
  /** Replace the window with a finished response's (already bounded) messages. */
  replace: (messages: string[] | undefined, dropped?: number) => void;
}

/** Bounded live message list for the builder's Stream tab. */
export function useStreamMessageLog(): StreamMessageLog {
  const [log, setLog] = useState<RetainedMessages<string>>(emptyRetained);
  const append = useCallback((text: string) => setLog((prev) => appendRetained(prev, text)), []);
  const reset = useCallback(() => setLog(emptyRetained()), []);
  const replace = useCallback(
    (messages: string[] | undefined, dropped = 0) => setLog(retainedFrom(messages, dropped)),
    []
  );
  const positions = log.seqs ?? log.items.map((_, i) => log.dropped + i + 1);
  return { messages: log.items, dropped: log.dropped, positions, append, reset, replace };
}
