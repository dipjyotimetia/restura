import type * as grpc from '@grpc/grpc-js';
import * as crypto from 'crypto';
import { getGrpc } from './grpc-lazy';
import { unwrapSecretValueMain } from './secret-handle-store';
import { createLogger } from '../../src/lib/shared/logger';

const log = createLogger('grpc-tls');

/**
 * TLS material for a gRPC dial over `https://` / `grpcs://`. Mirrors the HTTP
 * handler's verifySsl / clientCert / caCert so a self-signed, private-CA, or
 * mTLS gRPC server is reachable from desktop. Native `@grpc/grpc-js` otherwise
 * builds SSL credentials that trust only the OS root store, so reflection AND
 * every call fail at the TLS handshake against an internally-issued cert.
 *
 * Structural (not the Zod-inferred type) so the reflection handler can import
 * this without depending on ipc-validators.
 */
export interface GrpcTlsConfig {
  verifySsl?: boolean;
  clientCert?: {
    pfx?: string;
    cert?: string;
    key?: string;
    passphrase?: unknown; // SecretValue (ADR-0007) — resolved here, main-side.
  };
  caCert?: { pem: string };
}

/**
 * Build channel credentials for a gRPC dial.
 *
 * - Plaintext (`useTls === false`) → `createInsecure()`.
 * - TLS → `createSsl(rootCerts, privateKey, certChain, verifyOptions)`:
 *   - `caCert.pem` becomes `rootCerts` — the secure way to trust a self-signed
 *     or private-CA server (paste the server/CA cert in settings).
 *   - `clientCert.cert` + `clientCert.key` enable mTLS; an encrypted key is
 *     decrypted main-side with its passphrase (grpc-js wants a raw key).
 *   - `verifySsl === false` relaxes the hostname check only — grpc-js has no
 *     `rejectUnauthorized`, so trusting an untrusted chain requires the CA.
 */
export function buildGrpcCredentials(
  useTls: boolean,
  tls?: GrpcTlsConfig
): grpc.ChannelCredentials {
  const grpcLib = getGrpc();
  if (!useTls) return grpcLib.credentials.createInsecure();

  const rootCerts: Buffer | null = tls?.caCert?.pem ? Buffer.from(tls.caCert.pem) : null;

  let privateKey: Buffer | null = null;
  let certChain: Buffer | null = null;
  const cc = tls?.clientCert;
  if (cc?.cert && cc.key) {
    certChain = Buffer.from(cc.cert);
    const passphrase = unwrapSecretValueMain(cc.passphrase);
    if (passphrase) {
      // grpc-js createSsl takes a raw (unencrypted) private key, so decrypt a
      // passphrase-protected PEM key here rather than failing the handshake.
      try {
        const keyObj = crypto.createPrivateKey({ key: cc.key, passphrase });
        privateKey = Buffer.from(keyObj.export({ format: 'pem', type: 'pkcs8' }) as string);
      } catch (e) {
        log.error('failed to decrypt client key with passphrase', {
          error: e instanceof Error ? e.message : String(e),
        });
        privateKey = Buffer.from(cc.key);
      }
    } else {
      privateKey = Buffer.from(cc.key);
    }
  } else if (cc?.pfx) {
    // grpc-js createSsl requires PEM material; PKCS#12/PFX has no built-in
    // parser. Warn so the user isn't silently dialed without their client cert.
    log.warn('PFX client certificates are not supported for gRPC mTLS — use a PEM cert + key');
  }

  const verifyOptions: grpc.VerifyOptions = {};
  if (tls?.verifySsl === false) {
    verifyOptions.checkServerIdentity = () => undefined;
  }

  return grpcLib.credentials.createSsl(rootCerts, privateKey, certChain, verifyOptions);
}
