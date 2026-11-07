// Capability rows: gRPC (native, Connect, gRPC-Web).
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const GRPC_CAPABILITIES = {
  'grpc.basic': {
    label: 'gRPC unary + streaming',
    web: true,
    desktop: true,
    notes:
      'Web uses Connect transport (unary via /api/grpc; server-streaming connects directly, CORS permitting) — client/bidi streaming is desktop-only; desktop uses native gRPC with a Connect-protocol fallback only when the server refuses native gRPC (4xx except 408/429, 501, 505 — never on transient 5xx); the CLI auto mode is Connect-only and says so when a server refuses it',
  },
  'grpc.reflection': {
    label: 'gRPC reflection',
    web: true,
    desktop: true,
    notes:
      'Web reflects Connect-protocol servers (v1 with v1alpha fallback) via /api/grpc/reflection; the bidi RPC needs an HTTP/2 upstream hop (self-host negotiates h2 over TLS) — gRPC-only servers need desktop. Every platform walks the import closure (fileByFilename) so the saved descriptor set is complete',
  },
  'grpc.web': {
    label: 'gRPC-Web wire protocol (per-request selector)',
    web: true,
    desktop: true,
    notes:
      'Unary + server-streaming to gRPC-Web endpoints (e.g. Envoy grpc_web); needs reflection or a .proto. Web/self-host relay via /api/grpc-web (binary or grpc-web-text, messages streamed as they arrive); desktop pins connect-node gRPC-Web (binary only). The same selector pins native gRPC (desktop only) or Connect.',
  },
} as const satisfies Record<string, CapabilityRow>;
