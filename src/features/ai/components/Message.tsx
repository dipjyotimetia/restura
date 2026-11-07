import { Check, Copy, RotateCcw } from 'lucide-react';
import { memo, useState } from 'react';
import MarkdownPreview from '@/components/shared/MarkdownPreview';
import type { ChatMessage } from '@/features/ai/store';
import { cn } from '@/lib/shared';

interface Props {
  message: ChatMessage;
  /** Regenerate this reply. Passed only for the latest assistant message. */
  onRetry?: () => void;
}

function MessageImpl({ message, onRetry }: Props) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  // Finished assistant replies render as markdown (react-markdown escapes raw
  // HTML — no rehype-raw); streaming text stays plain so partial markup
  // doesn't re-parse on every delta.
  const asMarkdown = !isUser && message.status !== 'streaming' && message.text.length > 0;

  const copy = () => {
    void navigator.clipboard?.writeText(message.text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {}
    );
  };

  return (
    <div className={cn('flex flex-col gap-1 px-3 py-2', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg border px-3 py-2 text-sm break-words',
          !asMarkdown && 'whitespace-pre-wrap',
          isUser ? 'bg-accent/10 border-accent/20' : 'bg-sp-surface border-sp-line',
          message.status === 'error' && 'border-destructive/40'
        )}
      >
        {asMarkdown ? (
          <MarkdownPreview source={message.text} />
        ) : (
          message.text ||
          (message.status === 'streaming' ? (
            <span className="text-muted-foreground italic">…</span>
          ) : null)
        )}
        {message.status === 'error' && message.errorMessage && (
          <div className="mt-2 text-xs text-destructive">{message.errorMessage}</div>
        )}
      </div>
      {!isUser && message.status !== 'streaming' && (message.text || onRetry) && (
        <div className="flex items-center gap-1">
          {message.text && (
            <button
              type="button"
              onClick={copy}
              aria-label="Copy reply"
              title="Copy reply"
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-sp-11 text-sp-muted hover:bg-sp-hover hover:text-sp-text"
            >
              {copied ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Copy className="h-3 w-3" aria-hidden="true" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              aria-label="Retry"
              title="Regenerate this reply"
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-sp-11 text-sp-muted hover:bg-sp-hover hover:text-sp-text"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" /> Retry
            </button>
          )}
        </div>
      )}
      {!isUser && message.status === 'done' && (
        <div className="flex items-center gap-2 text-sp-11 text-sp-muted">
          {message.usage && (
            <span>
              {message.usage.promptTokens}+{message.usage.completionTokens} tok ·{' '}
              {message.usage.costUnknown
                ? 'cost unknown'
                : `$${message.usage.estimatedCostUSD.toFixed(4)}`}
            </span>
          )}
          <span>AI can be wrong — verify before acting.</span>
        </div>
      )}
    </div>
  );
}

export const Message = memo(MessageImpl);
