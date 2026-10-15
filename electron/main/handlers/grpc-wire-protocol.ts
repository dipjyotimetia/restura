// Per-request gRPC wire-protocol pinning for the Electron connect-node data
// plane (#914). Absent = auto: native gRPC with the Connect fallback planned in
// grpc-connect.ts. A pinned protocol yields exactly one transport — no fallback
// — over the SAME SSRF-pinned dial + TLS options (supplied by the caller's
// `buildBase`, which keeps this module free of a cycle back to grpc-connect).
import type { Transport } from '@connectrpc/connect';
import {
  compressionGzip,
  createConnectTransport,
  createGrpcTransport,
  createGrpcWebTransport,
} from '@connectrpc/connect-node';
import type { GrpcTlsConfig } from './grpc-credentials';

/** grpc-web-text is web-only: connect-node implements binary gRPC-Web only. */
export type GrpcWireProtocolChoice = 'grpc' | 'connect' | 'grpc-web';

export interface WireProtocolArgs {
  /** Pin the wire protocol; absent = native gRPC with Connect fallback. */
  wireProtocol?: GrpcWireProtocolChoice;
}

interface PinnableArgs<D> extends WireProtocolArgs {
  url: string;
  dial: D;
  tls?: GrpcTlsConfig;
  useCompression?: boolean;
}

/**
 * The caller's shared transport options. The size caps are required so a pinned
 * transport can never fall back to connect-node's ~4 GiB default (SEC-G1, #929).
 */
export interface PinnedTransportBase {
  baseUrl: string;
  nodeOptions: Record<string, unknown>;
  readMaxBytes: number;
  writeMaxBytes: number;
}

type BuildBase<D> = (url: string, dial: D, tls?: GrpcTlsConfig) => PinnedTransportBase;

/** Build the single pinned transport for `t.wireProtocol`. */
export function createPinnedTransport<D>(
  t: PinnableArgs<D> & { wireProtocol: GrpcWireProtocolChoice },
  buildBase: BuildBase<D>
): Transport {
  // baseUrl + pinned-dial nodeOptions + readMaxBytes/writeMaxBytes caps.
  const base = buildBase(t.url, t.dial, t.tls);
  const compression = t.useCompression ? { sendCompression: compressionGzip } : {};
  switch (t.wireProtocol) {
    case 'grpc':
      return createGrpcTransport({ ...base, ...compression });
    case 'connect':
      return createConnectTransport({ ...base, httpVersion: '2', ...compression });
    case 'grpc-web':
      // gRPC-Web endpoints (e.g. Envoy's grpc_web filter) are HTTP/1.1.
      return createGrpcWebTransport({ ...base, httpVersion: '1.1', ...compression });
  }
}

/** The transport plan for a pinned call, or null when the call is on auto. */
export function pinnedTransportPlan<D>(
  t: PinnableArgs<D>,
  buildBase: BuildBase<D>
): Array<{ protocol: GrpcWireProtocolChoice; transport: Transport }> | null {
  if (!t.wireProtocol) return null;
  const wireProtocol = t.wireProtocol;
  return [
    { protocol: wireProtocol, transport: createPinnedTransport({ ...t, wireProtocol }, buildBase) },
  ];
}
