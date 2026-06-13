import { cn } from '@/lib/shared/utils';

// Lightweight run/cell state indicator for AI Lab — a colored dot + label, no
// glow (data-surface rule). Distinct from the HTTP-status `StatusPill`, which
// keys off a numeric status code and carries a glow.
type Tone = 'active' | 'ok' | 'error' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  active: 'text-amber-500',
  ok: 'text-emerald-500',
  error: 'text-destructive',
  muted: 'text-sp-muted',
};

const STATE_TONE: Record<string, Tone> = {
  streaming: 'active',
  running: 'active',
  done: 'ok',
  error: 'error',
  cancelled: 'muted',
};

export function StatusChip({
  state,
  label,
  className,
}: {
  state: string;
  label?: string;
  className?: string;
}) {
  const tone = TONE_CLASS[STATE_TONE[state] ?? 'muted'];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-sp-11 font-medium', tone, className)}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label ?? state}
    </span>
  );
}
