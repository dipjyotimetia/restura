/**
 * Resolve desktop TLS material (verify toggle / mTLS client cert / custom CA)
 * for a gRPC URL from the global certificate-override settings — the same
 * store HTTP uses. Threaded into the Electron IPC call + reflection payloads so
 * native `@grpc/grpc-js` can reach a self-signed / private-CA / mTLS server
 * (its default SSL credentials trust only the OS root store).
 *
 * Web build never calls this — cert material must never leave the machine, and
 * the Worker has no per-request TLS control. Returns `undefined` when nothing
 * applies so the IPC payload stays clean.
 */
import { useSettingsStore } from '@/store/useSettingsStore';
import { selectCertForUrl } from '@/lib/shared/certMatcher';
import type { ClientCert, CaCert } from '@/types';

export interface GrpcTlsOptions {
  verifySsl?: boolean;
  clientCert?: ClientCert;
  caCert?: CaCert;
}

export function resolveGrpcTls(url: string): GrpcTlsOptions | undefined {
  const settings = useSettingsStore.getState().settings;
  const out: GrpcTlsOptions = {};

  if (settings.verifySsl !== undefined) out.verifySsl = settings.verifySsl;

  // Cert precedence: per-host match (most-specific-wins) > global cert.
  const matchedClientCert = selectCertForUrl(url, settings.clientCertificates);
  const clientCert = matchedClientCert?.cert ?? settings.clientCert;
  if (clientCert) out.clientCert = clientCert;

  const matchedCaCert = selectCertForUrl(url, settings.caCertificates);
  const caCert = (matchedCaCert ? { pem: matchedCaCert.pem } : undefined) ?? settings.caCert;
  if (caCert) out.caCert = caCert;

  return Object.keys(out).length > 0 ? out : undefined;
}
