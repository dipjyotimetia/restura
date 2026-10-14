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
  /** Earlier messages evicted to keep the window bounded. */
  dropped: number;
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
  return { messages: log.items, dropped: log.dropped, append, reset, replace };
}
