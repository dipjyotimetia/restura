import { selectCertForUrl } from '@shared/protocol/cert-matcher';
import { applyManagedTransportPolicy } from '../security/enterprise-network';
import { assertExecutionPolicyReady, getExecutionPolicy } from '../security/execution-policy';
import {
  getManagedCaCertificateBundle,
  getManagedEnterprisePolicy,
} from '../security/managed-enterprise-policy';

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
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  clientCert?: {
    pfx?: string;
    cert?: string;
    key?: string;
    passphrase?: unknown; // SecretValue (ADR-0007) — resolved main-side.
  };
  caCert?: { pem: string };
  proxy?: {
    enabled: boolean;
    type: 'none' | 'http' | 'https' | 'socks4' | 'socks5';
    host: string;
    port: number;
    auth?: { username: string; password: unknown };
  };
}

type GrpcPolicyTransportConfig = {
  url: string;
  verifySsl?: boolean;
  minTlsVersion?: GrpcTlsConfig['minTlsVersion'];
  clientCert?: GrpcTlsConfig['clientCert'];
  caCert?: GrpcTlsConfig['caCert'];
};

/**
 * Fold the acknowledged policy into an outbound unary or streaming gRPC call.
 * Request values remain deliberate overrides; absent fields inherit the
 * URL-scoped certificate choice and global timeout/TLS defaults.
 */
export function resolveGrpcExecutionPolicy<
  T extends GrpcPolicyTransportConfig & { timeoutMs?: number },
>(
  config: T
): T & {
  timeoutMs: number;
  verifySsl: boolean;
  minTlsVersion?: GrpcTlsConfig['minTlsVersion'];
} {
  assertExecutionPolicyReady();
  const policy = getExecutionPolicy();
  const managed = getManagedEnterprisePolicy();
  const url = new URL(config.url);
  const hostClientCert = selectCertForUrl(url, policy.certificates.clientCertificates);
  const hostCaCert = selectCertForUrl(url, policy.certificates.caCertificates);

  const resolved = {
    ...config,
    timeoutMs: config.timeoutMs ?? policy.timeout,
    verifySsl: config.verifySsl ?? policy.tls.verifySsl,
    minTlsVersion: config.minTlsVersion ?? policy.tls.minTlsVersion,
    clientCert: config.clientCert ?? hostClientCert?.cert ?? policy.certificates.clientCert,
    caCert: config.caCert ?? (hostCaCert ? { pem: hostCaCert.pem } : policy.certificates.caCert),
  };
  return applyManagedTransportPolicy(resolved, managed, getManagedCaCertificateBundle());
}

/** Reflection is a gRPC dial too, but its IPC contract names the deadline `timeout`. */
export function resolveGrpcReflectionExecutionPolicy<
  T extends GrpcPolicyTransportConfig & { timeout?: number },
>(
  config: T
): T & {
  timeout: number;
  verifySsl: boolean;
  minTlsVersion?: GrpcTlsConfig['minTlsVersion'];
} {
  assertExecutionPolicyReady();
  const policy = getExecutionPolicy();
  const managed = getManagedEnterprisePolicy();
  const url = new URL(config.url);
  const hostClientCert = selectCertForUrl(url, policy.certificates.clientCertificates);
  const hostCaCert = selectCertForUrl(url, policy.certificates.caCertificates);

  const resolved = {
    ...config,
    timeout: config.timeout ?? policy.timeout,
    verifySsl: config.verifySsl ?? policy.tls.verifySsl,
    minTlsVersion: config.minTlsVersion ?? policy.tls.minTlsVersion,
    clientCert: config.clientCert ?? hostClientCert?.cert ?? policy.certificates.clientCert,
    caCert: config.caCert ?? (hostCaCert ? { pem: hostCaCert.pem } : policy.certificates.caCert),
  };
  return applyManagedTransportPolicy(resolved, managed, getManagedCaCertificateBundle());
}
