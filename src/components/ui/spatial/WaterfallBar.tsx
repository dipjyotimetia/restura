import { cn } from '@/lib/shared/utils';

export interface WaterfallSegment {
  label: string;
  ms: number;
  color: string;
  emphasised?: boolean;
}

export interface WaterfallBarProps {
  segments: ReadonlyArray<WaterfallSegment>;
  width?: number;
  height?: number;
  className?: string;
}

const defaultPalette: Record<string, string> = {
  DNS: 'var(--color-info)',
  TCP: 'var(--color-method-put)',
  TLS: 'var(--color-proto-ws)',
  Request: 'var(--color-success)',
  Wait: 'var(--color-proto-http)',
  Download: 'var(--color-warning)',
};

export function makeSegments(input: Record<string, number>): WaterfallSegment[] {
  return Object.entries(input)
    .filter(([, ms]) => ms > 0)
    .map(([label, ms]) => ({
      label,
      ms,
      color: defaultPalette[label] ?? 'var(--color-neutral)',
      emphasised: label === 'Wait',
    }));
}

export function WaterfallBar({ segments, width = 220, height = 8, className }: WaterfallBarProps) {
  const total = segments.reduce((s, x) => s + x.ms, 0);
  if (total <= 0) {
    return (
      <div
        className={cn('rounded-full bg-sp-surface-lo border border-sp-line', className)}
        style={{ width, height }}
      />
    );
  }
  return (
    <div
      role="img"
      aria-label={`Timing waterfall: ${segments.map((s) => `${s.label} ${s.ms}ms`).join(', ')}`}
      className={cn('inline-flex overflow-hidden rounded-full border border-sp-line', className)}
      style={{ width, height }}
    >
      {segments.map((s) => (
        <div
          key={s.label}
          title={`${s.label}: ${s.ms} ms`}
          style={{
            width: `${(s.ms / total) * 100}%`,
            background: s.color,
            boxShadow: s.emphasised ? 'inset 0 0 6px var(--sp-accent)' : undefined,
          }}
        />
      ))}
    </div>
  );
}
