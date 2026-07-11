import { beforeEach, describe, expect, it } from 'vitest';
import { resolveMcpExecutionPolicy } from '../handlers/mcp-handler';
import { resolveSseExecutionPolicy } from '../handlers/sse-handler';
import { setExecutionPolicy } from '../security/execution-policy';

const globalClientCert = { format: 'pfx' as const, pfx: 'Z2xvYmFs' };
const hostClientCert = { format: 'pem' as const, cert: 'HOST-CERT', key: 'HOST-KEY' };

beforeEach(() => {
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: {
      enabled: true,
      type: 'https',
      host: 'policy-proxy.example.test',
      port: 8443,
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
      clientCertificates: [{ id: 'host-client', host: '*.example.test', cert: hostClientCert }],
      caCertificates: [{ id: 'host-ca', host: 'api.example.test', pem: 'HOST-CA' }],
    },
  });
});

describe.each([
  ['SSE', resolveSseExecutionPolicy],
  ['MCP', resolveMcpExecutionPolicy],
] as const)('%s execution policy', (_name, resolve) => {
  it('supplies acknowledged, URL-scoped defaults without discarding protocol fields', () => {
    expect(
      resolve({
        url: 'https://api.example.test/events',
        headers: { 'x-protocol-header': 'preserved' },
      })
    ).toMatchObject({
      headers: { 'x-protocol-header': 'preserved' },
      timeout: 45_000,
      proxy: {
        enabled: true,
        type: 'https',
        host: 'policy-proxy.example.test',
        port: 8443,
      },
      verifySsl: false,
      clientCert: hostClientCert,
      caCert: { pem: 'HOST-CA' },
      serverCipherOrder: true,
      minTlsVersion: 'TLSv1.2',
      cipherSuites: 'HIGH:!aNULL',
    });
  });

  it('keeps explicit transport settings over policy defaults', () => {
    const proxy = {
      enabled: true,
      type: 'http' as const,
      host: 'request-proxy.example.test',
      port: 3128,
    };
    const clientCert = { format: 'pfx' as const, pfx: 'cmVxdWVzdA==' };

    expect(
      resolve({
        url: 'https://api.example.test/events',
        timeout: 1_000,
        proxy,
        verifySsl: true,
        clientCert,
        caCert: { pem: 'REQUEST-CA' },
        serverCipherOrder: false,
        minTlsVersion: 'TLSv1.3',
        cipherSuites: 'REQUEST-CIPHERS',
      })
    ).toMatchObject({
      timeout: 1_000,
      proxy,
      verifySsl: true,
      clientCert,
      caCert: { pem: 'REQUEST-CA' },
      serverCipherOrder: false,
      minTlsVersion: 'TLSv1.3',
      cipherSuites: 'REQUEST-CIPHERS',
    });
  });
});
