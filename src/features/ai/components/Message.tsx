import { memo } from 'react';
import { cn } from '@/lib/shared';
import type { ChatMessage } from '@/features/ai/store';

interface Props {
  message: ChatMessage;
}

function MessageImpl({ message }: Props) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex flex-col gap-1 px-3 py-2', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'glass-1 max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
          isUser ? 'bg-accent/10 border-accent/20' : 'border-border/40',
          message.status === 'error' && 'border-destructive/40',
        )}
      >
        {message.text || (message.status === 'streaming' ? <span className="text-muted-foreground italic">…</span> : null)}
        {message.status === 'error' && message.errorMessage && (
          <div className="mt-2 text-xs text-destructive">{message.errorMessage}</div>
        )}
      </div>
      {!isUser && message.status === 'done' && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
          {message.usage && (
            <span>
              {message.usage.promptTokens}+{message.usage.completionTokens} tok · ${message.usage.estimatedCostUSD.toFixed(4)}
            </span>
          )}
          <span>AI can be wrong — verify before acting.</span>
        </div>
      )}
    </div>
  );
}

export const Message = memo(MessageImpl);
