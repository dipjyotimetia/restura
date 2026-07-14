import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

function pickColor(status: number): { color: string; bg: string; glow: string } {
  if (status >= 200 && status <= 299) {
    return {
      color: 'var(--color-success)',
      bg: 'color-mix(in srgb, var(--color-success) 16%, transparent)',
      glow: '0 0 8px color-mix(in srgb, var(--color-success) 45%, transparent)',
    };
  }
  if (status >= 300 && status <= 399) {
    return {
      color: 'var(--color-info)',
      bg: 'color-mix(in srgb, var(--color-info) 16%, transparent)',
      glow: '0 0 8px color-mix(in srgb, var(--color-info) 45%, transparent)',
    };
  }
  if (status >= 400) {
    return {
      color: 'var(--color-danger)',
      bg: 'color-mix(in srgb, var(--color-danger) 18%, transparent)',
      glow: '0 0 8px color-mix(in srgb, var(--color-danger) 45%, transparent)',
    };
  }
  return {
    color: 'var(--color-neutral)',
    bg: 'color-mix(in srgb, var(--color-neutral) 16%, transparent)',
    glow: 'none',
  };
}

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: number;
  text?: string;
  showGlow?: boolean;
  ref?: React.Ref<HTMLSpanElement>;
}

export function StatusPill({
  status,
  text,
  showGlow = true,
  className,
  style,
  ref,
  ...props
}: StatusPillProps) {
  const { color, bg, glow } = pickColor(status);
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-2.5 font-mono font-bold text-sp-12 tabular-nums rounded-sp-btn',
        className
      )}
      style={{
        color,
        background: bg,
        boxShadow: showGlow ? glow : undefined,
        ...style,
      }}
      {...props}
    >
      <span aria-hidden="true">●</span>
      <span>{status}</span>
      {text && <span className="font-normal opacity-80">{text}</span>}
    </span>
  );
}
StatusPill.displayName = 'StatusPill';
