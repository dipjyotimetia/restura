// gRPC unary, streaming and reflection IPC types (`window.electron.grpc`).

import type { ProtocolSecretValue } from './shared';

/** TLS trust / mTLS material shared by the call and reflection payloads. */
interface GrpcTlsIpc {
  verifySsl?: boolean;
  clientCert?: { pfx?: string; cert?: string; key?: string; passphrase?: ProtocolSecretValue };
  caCert?: { pem: string };
}

/**
 * `grpc:request` / `grpc:start-stream` payload. Either `protoContent` or
 * `descriptors` must be present (a schema refinement, not expressible here).
 */
export interface GrpcCallIpcConfig extends GrpcTlsIpc {
  /** Stream id (alphanumeric, dashes, underscores; at most 64 chars). */
  id?: string;
  url: string;
  service: string;
  method: string;
  methodType: 'unary' | 'server-streaming' | 'client-streaming' | 'bidirectional-streaming';
  metadata: Record<string, string>;
  message: unknown;
  protoContent?: string;
  protoFileName?: string;
  /** Base64 FileDescriptorProtos from server reflection. */
  descriptors?: string[];
  useCompression?: boolean;
  wireProtocol?: 'grpc' | 'connect' | 'grpc-web';
  /** Milliseconds; 0 (no deadline) is for streaming methods only. */
  timeoutMs?: number;
  /** Only when a credential holds a SecretRef handle; resolved main-side (ADR-0007). */
  auth?: import('../../../../shared/types/auth').AuthConfig;
}

export interface GrpcIpcResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  message?: unknown;
  messages?: unknown[];
  trailers: Record<string, string>;
  error?: string;
  details?: string;
  /** Decoded google.rpc.Status error details (see shared/protocol/grpc-status-details). */
  statusDetails?: import('../../../../shared/protocol/grpc-status-details').GrpcStatusDetail[];
}

export interface GrpcReflectionConfig extends GrpcTlsIpc {
  url: string;
  reflectionService: string;
  request: Record<string, unknown>;
  timeout?: number;
  /** Request metadata (incl. inline auth headers) sent with reflection (#887). */
  metadata?: Record<string, string>;
  /**
   * Auth descriptor, only when it holds a SecretRef handle the renderer can't
   * read; resolved main-side (ADR-0007).
   */
  auth?: import('../../../../shared/types/auth').AuthConfig;
  // TLS trust / mTLS material (GrpcTlsIpc, resolved per-host from cert-override
  // settings), so Discover reaches a self-signed / private-CA / mTLS server.
}

export interface GrpcRawReflectionResponse {
  listServicesResponse?: { service: Array<{ name: string }> };
  fileDescriptorResponse?: { fileDescriptorProto: string[] };
  errorResponse?: { errorCode: number; errorMessage: string };
}

export interface ElectronGrpcAPI {
  request: (config: GrpcCallIpcConfig) => Promise<GrpcIpcResult>;
  reflect: (config: GrpcReflectionConfig) => Promise<GrpcRawReflectionResponse>;
  startStream: (config: GrpcCallIpcConfig) => void;
  sendMessage: (requestId: string, message: unknown) => void;
  endStream: (requestId: string) => void;
  cancelStream: (requestId: string) => void;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}
