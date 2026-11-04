import { getEffectiveProxy, shouldBypassProxy } from '@/features/http/lib/proxyHelper';
import { selectCertForUrl } from '@/lib/shared/certMatcher';
import type { DesktopTransportConfig } from '@/lib/shared/transport';
import type { AppSettings, RequestSettings } from '@/types';

/**
 * Assemble the desktop-only transport config from per-request settings,
 * falling back to global settings. Proxy precedence follows
 * `getEffectiveProxy` (per-request overrides global); a proxy whose host is
 * on its own bypass list is dropped for this URL. Cert / verifySsl / TLS
 * knobs prefer the per-request value and fall back to the global one.
 *
 * Returns undefined when nothing desktop-specific applies, so the web path
 * stays a pure no-op.
 *
 * Exported for unit testing — this is the precedence logic (per-request >
 * per-domain match > global) that the type system can't verify end-to-end.
 */
export function buildDesktopTransportConfig(
  effectiveSettings: RequestSettings,
  globalSettings: AppSettings,
  resolvedUrl: string
): DesktopTransportConfig | undefined {
  const out: DesktopTransportConfig = {};

  const proxy = getEffectiveProxy(effectiveSettings, globalSettings.proxy);
  if (
    proxy?.enabled &&
    proxy.type !== 'none' &&
    proxy.host &&
    !shouldBypassProxy(resolvedUrl, proxy.bypassList)
  ) {
    out.proxy = proxy;
  }

  const verifySsl = effectiveSettings.verifySsl ?? globalSettings.verifySsl;
  if (verifySsl !== undefined) out.verifySsl = verifySsl;

  // Cert precedence: explicit per-request override > per-domain match >
  // global cert. The per-domain lists are matched most-specific-first.
  const matchedClientCert = selectCertForUrl(resolvedUrl, globalSettings.clientCertificates);
  const clientCert =
    effectiveSettings.clientCert ?? matchedClientCert?.cert ?? globalSettings.clientCert;
  if (clientCert) out.clientCert = clientCert;

  const matchedCaCert = selectCertForUrl(resolvedUrl, globalSettings.caCertificates);
  const caCert =
    effectiveSettings.caCert ??
    (matchedCaCert ? { pem: matchedCaCert.pem } : undefined) ??
    globalSettings.caCert;
  if (caCert) out.caCert = caCert;

  const serverCipherOrder = effectiveSettings.serverCipherOrder ?? globalSettings.serverCipherOrder;
  if (serverCipherOrder !== undefined) out.serverCipherOrder = serverCipherOrder;

  const minTlsVersion = effectiveSettings.minTlsVersion ?? globalSettings.minTlsVersion;
  if (minTlsVersion !== undefined) out.minTlsVersion = minTlsVersion;

  const cipherSuites = effectiveSettings.cipherSuites ?? globalSettings.cipherSuites;
  if (cipherSuites !== undefined) out.cipherSuites = cipherSuites;

  // Per-request only (no workspace default). 'auto' is the handler default, so
  // it isn't sent — keeps the IPC payload identical for untouched requests.
  if (effectiveSettings.httpVersion && effectiveSettings.httpVersion !== 'auto') {
    out.httpVersion = effectiveSettings.httpVersion;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
