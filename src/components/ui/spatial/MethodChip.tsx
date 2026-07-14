import type * as React from 'react';
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

// Each method maps to a Spatial Depth color token (defined in globals.css
// @theme). Single source of truth — the chip never hardcodes a color.
const styles: Record<MethodBadge, string> = {
  GET: '--color-method-get',
  POST: '--color-method-post',
  PUT: '--color-method-put',
  PATCH: '--color-method-patch',
  DELETE: '--color-method-delete',
  HEAD: '--color-method-head',
  OPTIONS: '--color-method-options',
  WS: '--color-method-ws',
  SSE: '--color-method-sse',
  MCP: '--color-method-mcp',
  GQL: '--color-method-gql',
  GRPC: '--color-proto-grpc',
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
  ref?: React.Ref<HTMLSpanElement>;
}

export function MethodChip({
  method,
  hasPicker,
  size = 'md',
  className,
  style,
  ref,
  ...props
}: MethodChipProps) {
  const key = methodLabel(method);
  const token = styles[key];
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
      style={{
        color: `var(${token})`,
        background: `color-mix(in srgb, var(${token}) 15%, transparent)`,
        ...style,
      }}
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
MethodChip.displayName = 'MethodChip';
