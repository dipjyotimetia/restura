// gRPC unary, streaming and reflection IPC types (`window.electron.grpc`).

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

export interface GrpcReflectionConfig {
  url: string;
  reflectionService: string;
  request: Record<string, unknown>;
  timeout?: number;
  /** Request metadata (incl. inline auth headers) sent with reflection (#887). */
  metadata?: Record<string, string>;
  /**
   * Auth descriptor, only when it holds a SecretRef handle the renderer can't
   * read; resolved main-side (ADR-0007). Validated by ReflectionIpcConfigSchema.
   */
  auth?: unknown;
  // TLS trust / mTLS material (resolved per-host from cert-override settings),
  // so Discover reaches a self-signed / private-CA / mTLS server.
  verifySsl?: boolean;
  clientCert?: { pfx?: string; cert?: string; key?: string; passphrase?: unknown };
  caCert?: { pem: string };
}

export interface GrpcRawReflectionResponse {
  listServicesResponse?: { service: Array<{ name: string }> };
  fileDescriptorResponse?: { fileDescriptorProto: string[] };
  errorResponse?: { errorCode: number; errorMessage: string };
}

export interface ElectronGrpcAPI {
  request: (config: unknown) => Promise<GrpcIpcResult>;
  reflect: (config: GrpcReflectionConfig) => Promise<GrpcRawReflectionResponse>;
  startStream: (config: unknown) => void;
  sendMessage: (requestId: string, message: unknown) => void;
  endStream: (requestId: string) => void;
  cancelStream: (requestId: string) => void;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}
