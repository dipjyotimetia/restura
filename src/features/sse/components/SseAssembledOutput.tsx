import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';

export interface SsePhase {
  id: string;
  label: string;
  state: 'pending' | 'active' | 'done';
}

export interface SseAssembledOutputProps {
  text: string;
  /** 0-1 progress, or `null` for indeterminate. */
  progress: number | null;
  phases: SsePhase[];
  /** Whether the stream is currently active — drives cursor visibility. */
  isStreaming: boolean;
}

/**
 * Right column top — typed assembled text with blinking accent cursor.
 * Progress bar uses the accent → violet gradient. Phase list below.
 */
export function SseAssembledOutput({
  text,
  progress,
  phases,
  isStreaming,
}: SseAssembledOutputProps) {
  const pct = progress == null ? null : Math.min(100, Math.max(0, progress * 100));
  return (
    <Floater
      radius="panel"
      elevation="float"
      className="flex flex-col overflow-hidden flex-1 min-h-0"
    >
      <div className="flex items-center justify-between px-4 h-11 border-b border-sp-line shrink-0">
        <span className="sp-label">Assembled output</span>
        <span className="font-mono text-sp-9 text-sp-dim tabular-nums">{text.length} chars</span>
      </div>

      {/* Body */}
      <div className="px-4 py-3 flex flex-col gap-2.5 flex-1 min-h-0">
        <div
          className={cn(
            'rounded-sp-btn p-3 font-mono text-sp-12 text-sp-text whitespace-pre-wrap break-words',
            'flex-1 min-h-[120px] overflow-y-auto'
          )}
          style={{
            background: 'var(--sp-surface-lo)',
            border: '1px solid var(--sp-line)',
          }}
          aria-live="polite"
          aria-atomic="false"
        >
          {text || <span className="text-sp-dim italic">Waiting for tokens…</span>}
          {/* Blinking accent cursor — only while streaming. */}
          {isStreaming && (
            <span
              aria-hidden="true"
              className="inline-block align-middle ml-0.5"
              style={{
                width: 8,
                height: '1em',
                background: 'var(--sp-accent-glow-33)',
                borderRight: '2px solid var(--sp-accent)',
                animation: 'blink 1s infinite',
              }}
            />
          )}
        </div>

        {/* Progress bar */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="sp-label">Progress</span>
            <span className="font-mono text-sp-9 text-sp-dim tabular-nums">
              {pct == null ? '—' : `${pct.toFixed(0)}%`}
            </span>
          </div>
          <div
            className="relative h-1.5 rounded-full overflow-hidden"
            style={{
              background: 'var(--sp-surface-lo)',
              border: '1px solid var(--sp-line)',
            }}
            role="progressbar"
            aria-label="Stream progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            <div
              className={cn(
                'absolute inset-y-0 left-0 transition-[width] duration-200',
                pct == null && isStreaming && 'animate-pulse'
              )}
              style={{
                width: pct == null ? (isStreaming ? '40%' : '0%') : `${pct}%`,
                background: 'linear-gradient(90deg, var(--sp-accent), var(--color-proto-ws))',
                boxShadow: '0 0 8px var(--sp-accent-glow-33)',
              }}
            />
          </div>
        </div>

        {/* Phases */}
        {phases.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="sp-label">Phases</span>
            <ul className="flex flex-col gap-1">
              {phases.map((p) => {
                const stateColor =
                  p.state === 'done'
                    ? 'var(--color-success)'
                    : p.state === 'active'
                      ? 'var(--sp-accent)'
                      : 'var(--sp-text-dim)';
                return (
                  <li key={p.id} className="flex items-center gap-2 font-mono text-sp-11">
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full inline-block"
                      style={{
                        background: stateColor,
                        boxShadow:
                          p.state === 'active' ? '0 0 6px var(--sp-accent-glow-55)' : 'none',
                      }}
                    />
                    <span
                      className={cn(
                        p.state === 'done' && 'text-sp-muted',
                        p.state === 'pending' && 'text-sp-dim',
                        p.state === 'active' && 'text-sp-text'
                      )}
                    >
                      {p.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Floater>
  );
}

export default SseAssembledOutput;
