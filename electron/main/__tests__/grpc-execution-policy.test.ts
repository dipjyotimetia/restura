import { beforeEach, describe, expect, it } from 'vitest';
import {
  resolveGrpcExecutionPolicy,
  resolveGrpcReflectionExecutionPolicy,
} from '../handlers/grpc-credentials';
import { setExecutionPolicy } from '../security/execution-policy';

const globalClientCert = { format: 'pfx' as const, pfx: 'Z2xvYmFs' };
const hostClientCert = { format: 'pem' as const, cert: 'HOST-CERT', key: 'HOST-KEY' };

beforeEach(() => {
  setExecutionPolicy({
    security: { allowLocalhost: true, allowPrivateIPs: false },
    proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
    timeout: 45_000,
    tls: { verifySsl: false, serverCipherOrder: true },
    certificates: {
      clientCert: globalClientCert,
      caCert: { pem: 'GLOBAL-CA' },
      clientCertificates: [{ id: 'host-client', host: '*.example.test', cert: hostClientCert }],
      caCertificates: [{ id: 'host-ca', host: 'api.example.test', pem: 'HOST-CA' }],
    },
  });
});

describe('gRPC execution policy', () => {
  it('supplies acknowledged defaults selected for unary and streaming URLs', () => {
    expect(resolveGrpcExecutionPolicy({ url: 'grpcs://api.example.test' })).toMatchObject({
      timeoutMs: 45_000,
      verifySsl: false,
      clientCert: hostClientCert,
      caCert: { pem: 'HOST-CA' },
    });
  });

  it('keeps explicit unary and streaming transport settings over policy defaults', () => {
    const requestClientCert = { pfx: 'cmVxdWVzdA==' };
    expect(
      resolveGrpcExecutionPolicy({
        url: 'grpcs://api.example.test',
        timeoutMs: 1_000,
        verifySsl: true,
        clientCert: requestClientCert,
        caCert: { pem: 'REQUEST-CA' },
      })
    ).toMatchObject({
      timeoutMs: 1_000,
      verifySsl: true,
      clientCert: requestClientCert,
      caCert: { pem: 'REQUEST-CA' },
    });
  });

  it('uses the same defaults for reflection while preserving explicit settings', () => {
    expect(resolveGrpcReflectionExecutionPolicy({ url: 'grpcs://unmatched.test' })).toMatchObject({
      timeout: 45_000,
      verifySsl: false,
      clientCert: globalClientCert,
      caCert: { pem: 'GLOBAL-CA' },
    });

    const requestClientCert = { pfx: 'cmVmbGVjdGlvbg==' };
    expect(
      resolveGrpcReflectionExecutionPolicy({
        url: 'grpcs://api.example.test',
        timeout: 2_000,
        verifySsl: true,
        clientCert: requestClientCert,
        caCert: { pem: 'REFLECTION-CA' },
      })
    ).toMatchObject({
      timeout: 2_000,
      verifySsl: true,
      clientCert: requestClientCert,
      caCert: { pem: 'REFLECTION-CA' },
    });
  });
});
