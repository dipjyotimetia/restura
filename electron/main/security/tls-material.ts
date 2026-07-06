import { unwrapSecretValueMain } from './secret-handle-store';

/**
 * mTLS client-certificate + custom-CA input shared by the HTTP and gRPC TLS
 * paths. Structural (not the concrete `ClientCert`/`GrpcTlsConfig` types) so
 * both `HttpRequestConfig` and `GrpcTlsConfig` satisfy it without a dependency
 * between the two handlers.
 */
export interface TlsClientMaterialInput {
  clientCert?: {
    pfx?: string;
    cert?: string;
    key?: string;
    passphrase?: unknown; // SecretValue (ADR-0007) — resolved main-side.
  };
  caCert?: { pem: string };
}

/**
 * Resolve the mTLS client cert + custom CA into the options `tls.connect` (undici
 * connector) and Node's http2 TLS options both understand:
 * `{ ca?, pfx? | cert?+key?, passphrase? }`.
 *
 * Single source of truth so cert/CA handling can't drift between the HTTP and
 * gRPC paths (they previously each inlined this, and the SOCKS path silently
 * dropped it). The passphrase SecretValue is resolved to plaintext main-side
 * (ADR-0007) — a handle never crosses back to the renderer. It does NOT set
 * `rejectUnauthorized`/`servername`: those are per-transport concerns the caller
 * still owns.
 */
export function buildTlsClientMaterial(cfg: TlsClientMaterialInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const cc = cfg.clientCert;
  if (cc) {
    const passphrase = unwrapSecretValueMain(cc.passphrase);
    if (cc.pfx) {
      out.pfx = Buffer.from(cc.pfx, 'base64');
      if (passphrase) out.passphrase = passphrase;
    } else if (cc.cert && cc.key) {
      out.cert = cc.cert;
      out.key = cc.key;
      if (passphrase) out.passphrase = passphrase;
    }
  }
  if (cfg.caCert?.pem) {
    out.ca = cfg.caCert.pem;
  }
  return out;
}
