import { Code2, Play, Square } from 'lucide-react';
import { VariableUrlInput } from '@/components/shared/VariableUrlInput';
import { Button } from '@/components/ui/button';
import { CountToggle, MethodChip } from '@/components/ui/spatial';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { cn } from '@/lib/shared/utils';

export interface SseUrlBarProps {
  url: string;
  onUrlChange: (url: string) => void;
  isStreaming: boolean;
  isConnecting: boolean;
  onStream: () => void;
  onStop: () => void;
  /** Configured headers, params, auth and non-default reconnect settings. */
  optionCount: number;
  headersOpen: boolean;
  onToggleHeaders: () => void;
  /** Open the "Generate code" dialog (EventSource / fetch / cURL). */
  onCode?: () => void;
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
  optionCount,
  headersOpen,
  onToggleHeaders,
  onCode,
}: SseUrlBarProps) {
  const showStop = isStreaming || isConnecting;
  const canStream = !showStop && url.trim().length > 0;

  return (
    <div className="flex items-center gap-2 px-3 h-12 border-b border-sp-line shrink-0 sp-floater rounded-none focus-within:ring-1 focus-within:ring-inset focus-within:ring-sp-accent/50">
      <MethodChip method="SSE" />
      <span className="text-sp-dim font-mono text-sm select-none shrink-0" aria-hidden="true">
        ›
      </span>

      <VariableUrlInput
        value={url}
        onValueChange={onUrlChange}
        variableScope="request"
        placeholder={ECHO_URLS.sse}
        disabled={showStop}
        aria-label="SSE endpoint URL"
        className="flex-1 h-8"
        textClassName="px-2 text-sp-12 placeholder:italic disabled:cursor-not-allowed disabled:opacity-50"
      />

      <CountToggle
        label="Options"
        count={optionCount}
        expanded={headersOpen}
        onToggle={onToggleHeaders}
      />

      {onCode && (
        <button
          type="button"
          onClick={onCode}
          aria-label="Generate code"
          title="Generate code for this stream"
          className="h-8 w-8 inline-flex items-center justify-center shrink-0 rounded-sp-btn text-sp-muted hover:text-sp-text hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
        >
          <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}

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
