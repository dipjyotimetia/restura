import * as React from 'react';
import { cn } from '@/lib/shared/utils';

function pickColor(status: number): { color: string; bg: string; glow: string } {
  if (status >= 200 && status <= 299) {
    return { color: '#22c55e', bg: 'rgba(34,197,94,0.16)', glow: '0 0 8px rgba(34,197,94,0.45)' };
  }
  if (status >= 300 && status <= 399) {
    return { color: '#06b6d4', bg: 'rgba(6,182,212,0.16)', glow: '0 0 8px rgba(6,182,212,0.45)' };
  }
  if (status >= 400) {
    return { color: '#ef4444', bg: 'rgba(239,68,68,0.18)', glow: '0 0 8px rgba(239,68,68,0.45)' };
  }
  return { color: '#94a3b8', bg: 'rgba(148,163,184,0.16)', glow: 'none' };
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
