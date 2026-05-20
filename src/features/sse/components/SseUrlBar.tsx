import { Play, Square } from 'lucide-react';
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
    <div className="flex items-center gap-2 px-3 h-12 border-b border-sp-line shrink-0 sp-floater rounded-none">
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
          className="w-full h-8 bg-transparent border-0 outline-none font-mono text-sp-12 text-sp-text placeholder:text-sp-dim px-2 disabled:cursor-not-allowed disabled:opacity-70"
          style={{ caretColor: 'var(--sp-accent)' }}
        />
        {/* Read-only highlight overlay for {{vars}} when not focused — render
            absolutely on top but only when the input isn't being edited. We
            keep it purely decorative here since the native input is the
            source of truth. */}
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
            'border border-[rgba(239,68,68,0.35)] text-[#ef4444] bg-[rgba(239,68,68,0.10)]',
            'hover:bg-[rgba(239,68,68,0.18)] transition-colors'
          )}
        >
          <Square className="h-3.5 w-3.5" />
          Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={onStream}
          disabled={!canStream}
          aria-label="Start SSE stream"
          className={cn(
            'h-8 min-w-[88px] px-3 rounded-sp-btn text-sp-12 font-semibold text-white',
            'inline-flex items-center justify-center gap-1.5 shrink-0',
            'transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50',
            'enabled:hover:brightness-110 enabled:active:brightness-95'
          )}
          style={{
            background: 'linear-gradient(180deg, var(--sp-accent), #3a82e6)',
            boxShadow: canStream
              ? '0 0 0 1px var(--sp-accent-glow-33), 0 0 16px var(--sp-accent-glow-26)'
              : 'none',
          }}
        >
          <Play className="h-3.5 w-3.5" />
          Stream
        </button>
      )}
    </div>
  );
}

export default SseUrlBar;
