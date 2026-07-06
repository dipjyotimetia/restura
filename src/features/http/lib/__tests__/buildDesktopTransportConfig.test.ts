import { describe, it, expect } from 'vitest';
import { buildDesktopTransportConfig } from '../requestExecutor';
import type {
  RequestSettings,
  AppSettings,
  ProxyConfig,
  ClientCert,
  HostClientCert,
} from '@/types';

// Minimal fixtures — only the fields buildDesktopTransportConfig reads are set;
// the rest are cast away (mirrors the partial-object style in proxyHelper.test).
// NB: the global-settings helper is named `app`, NOT `global` — the latter
// shadows Node's global object and breaks the fixtures under vitest.
const settings = (over: Partial<RequestSettings> = {}): RequestSettings =>
  ({
    timeout: 30000,
    followRedirects: true,
    maxRedirects: 10,
    verifySsl: true,
    ...over,
  }) as RequestSettings;

const app = (over: Partial<AppSettings> = {}): AppSettings =>
  ({ verifySsl: true, ...over }) as AppSettings;

const proxy = (over: Partial<ProxyConfig> = {}): ProxyConfig => ({
  enabled: true,
  type: 'http',
  host: 'proxy.example.com',
  port: 8080,
  ...over,
});

const pfx = (id: string): ClientCert => ({ format: 'pfx', pfx: id });

describe('buildDesktopTransportConfig', () => {
  const URL_ = 'https://api.example.com/v1';

  it('emits only verifySsl when no proxy/cert/TLS config applies', () => {
    // verifySsl defaults true on both, so it IS emitted — assert it's the only key.
    expect(buildDesktopTransportConfig(settings(), app(), URL_)).toEqual({ verifySsl: true });
  });

  it('emits an enabled proxy and drops a disabled one', () => {
    expect(
      buildDesktopTransportConfig(settings(), app({ proxy: proxy() }), URL_)?.proxy
    ).toMatchObject({ host: 'proxy.example.com', port: 8080 });
    expect(
      buildDesktopTransportConfig(settings(), app({ proxy: proxy({ enabled: false }) }), URL_)
        ?.proxy
    ).toBeUndefined();
  });

  it('drops a proxy whose host is on its own bypass list for this URL', () => {
    const p = proxy({ bypassList: ['*.example.com'] });
    expect(buildDesktopTransportConfig(settings(), app({ proxy: p }), URL_)?.proxy).toBeUndefined();
  });

  it('per-request proxy overrides the global proxy', () => {
    const result = buildDesktopTransportConfig(
      settings({ proxy: proxy({ host: 'req-proxy' }) }),
      app({ proxy: proxy({ host: 'global-proxy' }) }),
      URL_
    );
    expect(result?.proxy?.host).toBe('req-proxy');
  });

  it('cert precedence: per-request override beats per-domain match beats global', () => {
    const perDomain: HostClientCert = { id: 'd', host: 'api.example.com', cert: pfx('domain') };
    // per-request wins
    expect(
      buildDesktopTransportConfig(
        settings({ clientCert: pfx('request') }),
        app({ clientCertificates: [perDomain], clientCert: pfx('global') }),
        URL_
      )?.clientCert
    ).toEqual(pfx('request'));
    // per-domain match wins over global when no per-request
    expect(
      buildDesktopTransportConfig(
        settings(),
        app({ clientCertificates: [perDomain], clientCert: pfx('global') }),
        URL_
      )?.clientCert
    ).toEqual(pfx('domain'));
    // global is the fallback when no per-domain match
    expect(
      buildDesktopTransportConfig(
        settings(),
        app({
          clientCertificates: [{ id: 'x', host: 'other.com', cert: pfx('nope') }],
          clientCert: pfx('global'),
        }),
        URL_
      )?.clientCert
    ).toEqual(pfx('global'));
  });

  it('selects a per-domain CA cert by host and shapes it as { pem }', () => {
    const result = buildDesktopTransportConfig(
      settings(),
      app({ caCertificates: [{ id: 'c', host: '*.example.com', pem: 'PEM-DATA' }] }),
      URL_
    );
    expect(result?.caCert).toEqual({ pem: 'PEM-DATA' });
  });

  it('threads TLS knobs, preferring per-request over global', () => {
    const result = buildDesktopTransportConfig(
      settings({ minTlsVersion: 'TLSv1.3', cipherSuites: 'REQ' }),
      app({ serverCipherOrder: true, minTlsVersion: 'TLSv1.2', cipherSuites: 'GLOBAL' }),
      URL_
    );
    expect(result).toMatchObject({
      serverCipherOrder: true, // global (no per-request value)
      minTlsVersion: 'TLSv1.3', // per-request override
      cipherSuites: 'REQ', // per-request override
    });
  });

  it('honours a per-request verifySsl:false override', () => {
    expect(
      buildDesktopTransportConfig(settings({ verifySsl: false }), app(), URL_)?.verifySsl
    ).toBe(false);
  });

  it('carries the Security network policy only when it departs from defaults', () => {
    // Defaults (localhost allowed, private blocked) emit nothing extra.
    const dflt = buildDesktopTransportConfig(settings(), app(), URL_);
    expect(dflt?.allowLocalhost).toBeUndefined();
    expect(dflt?.allowPrivateIPs).toBeUndefined();

    // Non-default choices are threaded through to the desktop transport.
    const tightened = buildDesktopTransportConfig(
      settings(),
      app({ allowLocalhost: false, allowPrivateIPs: true }),
      URL_
    );
    expect(tightened?.allowLocalhost).toBe(false);
    expect(tightened?.allowPrivateIPs).toBe(true);
  });
});
