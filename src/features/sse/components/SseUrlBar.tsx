import { Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MethodChip, VariableText } from '@/components/ui/spatial';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { cn } from '@/lib/shared/utils';

export interface SseUrlBarProps {
  url: string;
  onUrlChange: (url: string) => void;
  isStreaming: boolean;
  isConnecting: boolean;
  onStream: () => void;
  onStop: () => void;
  headerCount: number;
  onToggleHeaders: () => void;
}

/**
 * SSE URL bar — Spatial Depth.
 * MethodChip (SSE) › URL input (with VariableText overlay for {{vars}})
 * › Stream button (accent gradient when idle, red when streaming).
 */
export function SseUrlBar({
  url,
  onUrlChange,
  isStreaming,
  isConnecting,
  onStream,
  onStop,
  headerCount,
  onToggleHeaders,
}: SseUrlBarProps) {
  const showStop = isStreaming || isConnecting;
  const canStream = !showStop && url.trim().length > 0;

  return (
    <div className="flex items-center gap-2 px-3 h-12 border-b border-sp-line shrink-0 sp-floater rounded-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-sp-accent/50">
      <MethodChip method="SSE" />
      <span className="text-sp-dim font-mono text-sm select-none shrink-0" aria-hidden="true">
        ›
      </span>

      <div className="relative flex-1 min-w-0">
        <input
          type="text"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={ECHO_URLS.sse}
          disabled={showStop}
          aria-label="SSE endpoint URL"
          className="w-full h-8 bg-transparent border-0 outline-none font-mono text-sp-12 text-sp-text placeholder:text-sp-dim px-2 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ caretColor: 'var(--sp-accent)' }}
        />
        {/* Decorative {{vars}} highlight overlay layered on top of the input.
            The text is transparent so it only contributes color spans behind
            the native input, which stays the source of truth for editing. */}
        {url && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center px-2 font-mono text-sp-12"
            aria-hidden="true"
          >
            <VariableText text={url} className="text-transparent" />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onToggleHeaders}
        className="h-7 px-2 rounded-sp-btn text-sp-11 text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors shrink-0"
      >
        Headers <span className="font-mono tabular-nums">({headerCount})</span>
      </button>

      {showStop ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop SSE stream"
          className={cn(
            'h-8 min-w-[88px] px-3 rounded-sp-btn text-sp-12 font-semibold',
            'inline-flex items-center justify-center gap-1.5 shrink-0',
            'border border-danger/35 text-danger bg-danger/10',
            'hover:bg-danger/18 transition-colors'
          )}
        >
          <Square className="h-3.5 w-3.5" />
          Stop
        </button>
      ) : (
        <Button
          type="button"
          variant="cta"
          size="cta"
          onClick={onStream}
          disabled={!canStream}
          aria-label="Start SSE stream"
          className="min-w-[88px] shrink-0"
        >
          <Play className="h-3.5 w-3.5" />
          Stream
        </Button>
      )}
    </div>
  );
}

export default SseUrlBar;
