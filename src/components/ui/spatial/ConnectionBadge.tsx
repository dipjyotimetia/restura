import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

/**
 * Shared connection/health status badge used by the streaming protocol clients
 * (Kafka, MQTT, …). A dot + label pill whose tint comes from the semantic
 * status tokens in globals.css (@theme). Extracted so the per-client badges
 * stay in lockstep instead of drifting (see the StatusPill sibling, which is
 * the numeric HTTP-status variant).
 */
export type ConnectionTone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE: Record<ConnectionTone, { color: string; bg: string; glow: string }> = {
  success: {
    color: 'var(--color-success)',
    bg: 'color-mix(in srgb, var(--color-success) 16%, transparent)',
    glow: '0 0 8px color-mix(in srgb, var(--color-success) 35%, transparent)',
  },
  warning: {
    color: 'var(--color-warning)',
    bg: 'color-mix(in srgb, var(--color-warning) 16%, transparent)',
    glow: '0 0 8px color-mix(in srgb, var(--color-warning) 35%, transparent)',
  },
  danger: {
    color: 'var(--color-danger)',
    bg: 'color-mix(in srgb, var(--color-danger) 16%, transparent)',
    glow: '0 0 8px color-mix(in srgb, var(--color-danger) 35%, transparent)',
  },
  neutral: {
    color: 'var(--color-neutral)',
    bg: 'color-mix(in srgb, var(--color-neutral) 16%, transparent)',
    glow: 'none',
  },
};

export interface ConnectionBadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  tone: ConnectionTone;
  label: string;
}

export function ConnectionBadge({ tone, label, className, style, ...props }: ConnectionBadgeProps) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-2.5 font-mono font-bold uppercase tracking-wide text-sp-11 rounded-sp-btn',
        className
      )}
      style={{ color: t.color, background: t.bg, boxShadow: t.glow, ...style }}
      {...props}
    >
      <span aria-hidden="true">●</span>
      {label}
    </span>
  );
}
ConnectionBadge.displayName = 'ConnectionBadge';
