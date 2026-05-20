import * as React from 'react';
import { cn } from '@/lib/shared/utils';

export type ProtocolName =
  | 'HTTP' | 'GRPC' | 'WS' | 'GQL' | 'MCP' | 'SSE' | 'KAFKA' | 'SOCKETIO';

const protoStyles: Record<ProtocolName, { color: string; bg: string; label: string }> = {
  HTTP: { color: '#4d9fff', bg: 'rgba(77,159,255,0.14)', label: 'HTTP' },
  GRPC: { color: '#22c55e', bg: 'rgba(34,197,94,0.14)', label: 'gRPC' },
  WS: { color: '#a78bfa', bg: 'rgba(167,139,250,0.16)', label: 'WS' },
  GQL: { color: '#e879a4', bg: 'rgba(232,121,164,0.16)', label: 'GQL' },
  MCP: { color: '#f59e0b', bg: 'rgba(245,158,11,0.16)', label: 'MCP' },
  SSE: { color: '#06b6d4', bg: 'rgba(6,182,212,0.16)', label: 'SSE' },
  KAFKA: { color: '#f472b6', bg: 'rgba(244,114,182,0.16)', label: 'Kafka' },
  SOCKETIO: { color: '#a78bfa', bg: 'rgba(167,139,250,0.16)', label: 'IO' },
};

export function normalizeProtocol(p: string): ProtocolName {
  const u = p.toUpperCase();
  if (u === 'GRAPHQL') return 'GQL';
  if (u === 'WEBSOCKET') return 'WS';
  if (u === 'SOCKET.IO' || u === 'SOCKETIO') return 'SOCKETIO';
  if (u in protoStyles) return u as ProtocolName;
  return 'HTTP';
}

export interface ProtoChipProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  protocol: string;
}

export const ProtoChip = React.forwardRef<HTMLSpanElement, ProtoChipProps>(
  ({ protocol, className, style, ...props }, ref) => {
    const key = normalizeProtocol(protocol);
    const { color, bg, label } = protoStyles[key];
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center h-5 px-1.5 font-mono font-bold uppercase tracking-wide text-sp-9 rounded-sp-chip',
          className
        )}
        style={{ color, background: bg, ...style }}
        {...props}
      >
        {label}
      </span>
    );
  }
);
ProtoChip.displayName = 'ProtoChip';
