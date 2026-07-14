import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

export type ProtocolName =
  | 'HTTP'
  | 'GRPC'
  | 'WS'
  | 'GQL'
  | 'MCP'
  | 'SSE'
  | 'KAFKA'
  | 'MQTT'
  | 'SOCKETIO';

// Each protocol maps to a Spatial Depth color token (defined in globals.css
// @theme). Single source of truth — the chip never hardcodes a color.
const protoStyles: Record<ProtocolName, { token: string; label: string }> = {
  HTTP: { token: '--color-proto-http', label: 'HTTP' },
  GRPC: { token: '--color-proto-grpc', label: 'gRPC' },
  WS: { token: '--color-proto-ws', label: 'WS' },
  GQL: { token: '--color-proto-gql', label: 'GQL' },
  MCP: { token: '--color-proto-mcp', label: 'MCP' },
  SSE: { token: '--color-proto-sse', label: 'SSE' },
  KAFKA: { token: '--color-proto-kafka', label: 'Kafka' },
  MQTT: { token: '--color-proto-mqtt', label: 'MQTT' },
  SOCKETIO: { token: '--color-proto-socketio', label: 'IO' },
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
  ref?: React.Ref<HTMLSpanElement>;
}

export function ProtoChip({ protocol, className, style, ref, ...props }: ProtoChipProps) {
  const key = normalizeProtocol(protocol);
  const { token, label } = protoStyles[key];
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center h-5 px-1.5 font-mono font-bold uppercase tracking-wide text-sp-9 rounded-sp-chip',
        className
      )}
      style={{
        color: `var(${token})`,
        background: `color-mix(in srgb, var(${token}) 15%, transparent)`,
        ...style,
      }}
      {...props}
    >
      {label}
    </span>
  );
}
ProtoChip.displayName = 'ProtoChip';
