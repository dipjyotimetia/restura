/**
 * TLS material for a gRPC dial over `https://` / `grpcs://`. Mirrors the HTTP
 * handler's verifySsl / clientCert / caCert so a self-signed, private-CA, or
 * mTLS gRPC server is reachable from desktop. Mapped onto Node's http2/tls
 * options by the connect-node transport builder (see grpc-connect.ts).
 *
 * Structural (not the Zod-inferred type) so any handler can import it without
 * depending on ipc-validators.
 */
export interface GrpcTlsConfig {
  verifySsl?: boolean;
  clientCert?: {
    pfx?: string;
    cert?: string;
    key?: string;
    passphrase?: unknown; // SecretValue (ADR-0007) — resolved main-side.
  };
  caCert?: { pem: string };
}
