import { beforeEach, describe, expect, it } from 'vitest';
import { resolveHttpExecutionPolicy } from '../handlers/http-handler';
import { setExecutionPolicy } from '../security/execution-policy';

const globalClientCert = { format: 'pfx' as const, pfx: 'Z2xvYmFs' };
const hostClientCert = { format: 'pem' as const, cert: 'HOST-CERT', key: 'HOST-KEY' };

beforeEach(() => {
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: {
      enabled: true,
      type: 'socks5',
      host: 'policy-proxy.example.test',
      port: 1080,
      bypassList: [],
    },
    timeout: 45_000,
    tls: {
      verifySsl: false,
      serverCipherOrder: true,
      minTlsVersion: 'TLSv1.2',
      cipherSuites: 'HIGH:!aNULL',
    },
    certificates: {
      clientCert: globalClientCert,
      caCert: { pem: 'GLOBAL-CA' },
      clientCertificates: [
        { id: 'host-client', host: '*.example.test', cert: hostClientCert },
      ],
      caCertificates: [{ id: 'host-ca', host: 'api.example.test', pem: 'HOST-CA' }],
    },
  });
});

describe('HTTP execution policy', () => {
  it('supplies acknowledged policy defaults selected for the outbound URL', () => {
    expect(
      resolveHttpExecutionPolicy({ method: 'GET', url: 'https://api.example.test/v1' })
    ).toMatchObject({
      timeout: 45_000,
      proxy: {
        enabled: true,
        type: 'socks5',
        host: 'policy-proxy.example.test',
        port: 1080,
      },
      verifySsl: false,
      clientCert: hostClientCert,
      caCert: { pem: 'HOST-CA' },
      serverCipherOrder: true,
      minTlsVersion: 'TLSv1.2',
      cipherSuites: 'HIGH:!aNULL',
    });
  });

  it('uses global certificates when the outbound URL has no host-specific match', () => {
    expect(
      resolveHttpExecutionPolicy({ method: 'GET', url: 'https://unmatched.test/v1' })
    ).toMatchObject({
      clientCert: globalClientCert,
      caCert: { pem: 'GLOBAL-CA' },
    });
  });

  it('keeps explicit IPC transport settings over policy defaults', () => {
    const requestClientCert = { format: 'pfx' as const, pfx: 'cmVxdWVzdA==' };
    const requestProxy = {
      enabled: true,
      type: 'http' as const,
      host: 'request-proxy.example.test',
      port: 3128,
      bypassList: [],
    };

    expect(
      resolveHttpExecutionPolicy({
        method: 'GET',
        url: 'https://api.example.test/v1',
        timeout: 1_000,
        proxy: requestProxy,
        verifySsl: true,
        clientCert: requestClientCert,
        caCert: { pem: 'REQUEST-CA' },
        serverCipherOrder: false,
        minTlsVersion: 'TLSv1.3',
        cipherSuites: 'REQUEST-CIPHERS',
      })
    ).toMatchObject({
      timeout: 1_000,
      proxy: requestProxy,
      verifySsl: true,
      clientCert: requestClientCert,
      caCert: { pem: 'REQUEST-CA' },
      serverCipherOrder: false,
      minTlsVersion: 'TLSv1.3',
      cipherSuites: 'REQUEST-CIPHERS',
    });
  });

  it('treats wildcard bypass entries as globs, not raw regular expressions', () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: {
        enabled: true,
        type: 'http',
        host: 'policy-proxy.example.test',
        port: 3128,
        bypassList: ['api*.example.com'],
      },
      timeout: 45_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });

    expect(
      resolveHttpExecutionPolicy({ method: 'GET', url: 'https://apiXexampleYcom/v1' }).proxy
    ).toEqual({
      enabled: true,
      type: 'http',
      host: 'policy-proxy.example.test',
      port: 3128,
    });
  });
});
