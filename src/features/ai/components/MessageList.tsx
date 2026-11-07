import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/features/ai/store';
import { Message } from './Message';

interface Props {
  messages: ChatMessage[];
  /** Regenerate the latest assistant reply (shown on that message only). */
  onRetry?: () => void;
}

export function MessageList({ messages, onRetry }: Props) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastMessageLength = messages.at(-1)?.text.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll when a message is added or the last one grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages.length, lastMessageLength]);
  const last = messages.at(-1);
  const retryId = onRetry && last?.role === 'assistant' ? last.id : null;
  return (
    // role="log" + polite: screen readers announce new replies without
    // interrupting; aria-relevant keeps it to additions.
    <div
      className="flex-1 overflow-y-auto"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="AI chat messages"
    >
      {messages.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          Ask about the request or response in the active tab.
        </div>
      ) : (
        messages.map((m) => (
          <Message key={m.id} message={m} {...(m.id === retryId && onRetry ? { onRetry } : {})} />
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
