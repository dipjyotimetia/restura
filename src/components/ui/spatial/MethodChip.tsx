import * as React from 'react';
import { cn } from '@/lib/shared/utils';

export type MethodBadge =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS'
  | 'WS'
  | 'SSE'
  | 'MCP'
  | 'GQL'
  | 'GRPC';

interface MethodStyle {
  color: string;
  bg: string;
}

const styles: Record<MethodBadge, MethodStyle> = {
  GET: { color: '#22c55e', bg: 'rgba(34,197,94,0.14)' },
  POST: { color: '#f59e0b', bg: 'rgba(245,158,11,0.16)' },
  PUT: { color: '#3b82f6', bg: 'rgba(59,130,246,0.16)' },
  PATCH: { color: '#a855f7', bg: 'rgba(168,85,247,0.16)' },
  DELETE: { color: '#ef4444', bg: 'rgba(239,68,68,0.16)' },
  HEAD: { color: '#06b6d4', bg: 'rgba(6,182,212,0.16)' },
  OPTIONS: { color: '#94a3b8', bg: 'rgba(148,163,184,0.16)' },
  WS: { color: '#a78bfa', bg: 'rgba(167,139,250,0.16)' },
  SSE: { color: '#06b6d4', bg: 'rgba(6,182,212,0.16)' },
  MCP: { color: '#f59e0b', bg: 'rgba(245,158,11,0.16)' },
  GQL: { color: '#e879a4', bg: 'rgba(232,121,164,0.16)' },
  GRPC: { color: '#22c55e', bg: 'rgba(34,197,94,0.14)' },
};

export function methodLabel(method: string): MethodBadge {
  const upper = method.toUpperCase();
  if (upper === 'DEL' || upper === 'DELETE') return 'DELETE';
  if (upper in styles) return upper as MethodBadge;
  return 'GET';
}

function displayLabel(method: MethodBadge): string {
  return method === 'DELETE' ? 'DEL' : method;
}

export interface MethodChipProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  method: string;
  hasPicker?: boolean;
  size?: 'sm' | 'md';
}

export const MethodChip = React.forwardRef<HTMLSpanElement, MethodChipProps>(
  ({ method, hasPicker, size = 'md', className, style, ...props }, ref) => {
    const key = methodLabel(method);
    const { color, bg } = styles[key];
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center font-mono font-bold uppercase tabular-nums tracking-wide',
          size === 'sm'
            ? 'h-5 px-1.5 text-sp-9 rounded-sp-chip'
            : 'h-7 px-3 text-sp-12 rounded-sp-btn',
          className
        )}
        style={{ color, background: bg, ...style }}
        {...props}
      >
        {displayLabel(key)}
        {hasPicker && (
          <svg
            aria-hidden="true"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="ml-1 opacity-70"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </span>
    );
  }
);
MethodChip.displayName = 'MethodChip';
