import { useEffect, useRef } from 'react';
import { Message } from './Message';
import type { ChatMessage } from '@/features/ai/store';

interface Props {
  messages: ChatMessage[];
}

export function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastMessageLength = messages.at(-1)?.text.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, lastMessageLength]);
  return (
    <div className="flex-1 overflow-y-auto">
      {messages.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          Ask about the request or response in the active tab.
        </div>
      ) : (
        messages.map((m) => <Message key={m.id} message={m} />)
      )}
      <div ref={bottomRef} />
    </div>
  );
}
