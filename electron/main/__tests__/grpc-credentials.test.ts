// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the lazy grpc loader so we can assert how credentials are constructed
// without a real TLS handshake. createSsl records (rootCerts, key, cert, opts).
const createInsecure = vi.fn(() => ({ kind: 'insecure' }));
const createSsl = vi.fn(
  (root: Buffer | null, key: Buffer | null, cert: Buffer | null, opts: unknown) => ({
    kind: 'ssl',
    root,
    key,
    cert,
    opts,
  })
);

vi.mock('../grpc-lazy', () => ({
  getGrpc: () => ({ credentials: { createInsecure, createSsl } }),
  getProtoLoader: () => ({}),
}));

vi.mock('../secret-handle-store', () => ({
  // Plain strings pass through; non-strings resolve to undefined (no passphrase).
  unwrapSecretValueMain: (v: unknown) => (typeof v === 'string' ? v : undefined),
}));

import { buildGrpcCredentials } from '../grpc-credentials';

describe('buildGrpcCredentials', () => {
  beforeEach(() => {
    createInsecure.mockClear();
    createSsl.mockClear();
  });

  it('uses insecure credentials for plaintext dials', () => {
    const creds = buildGrpcCredentials(false);
    expect(createInsecure).toHaveBeenCalledTimes(1);
    expect(createSsl).not.toHaveBeenCalled();
    expect(creds).toEqual({ kind: 'insecure' });
  });

  it('passes a custom CA as rootCerts (trusts self-signed / private CA)', () => {
    buildGrpcCredentials(true, { caCert: { pem: 'CA-PEM' } });
    const [root, key, cert] = createSsl.mock.calls[0]!;
    expect(root?.toString()).toBe('CA-PEM');
    expect(key).toBeNull();
    expect(cert).toBeNull();
  });

  it('wires mTLS cert + key as certChain + privateKey', () => {
    buildGrpcCredentials(true, { clientCert: { cert: 'CERT-PEM', key: 'KEY-PEM' } });
    const [root, key, cert] = createSsl.mock.calls[0]!;
    expect(root).toBeNull();
    expect(key?.toString()).toBe('KEY-PEM');
    expect(cert?.toString()).toBe('CERT-PEM');
  });

  it('relaxes the hostname check when verifySsl is false', () => {
    buildGrpcCredentials(true, { verifySsl: false });
    const opts = createSsl.mock.calls[0]![3] as { checkServerIdentity?: () => unknown };
    expect(typeof opts.checkServerIdentity).toBe('function');
    expect(opts.checkServerIdentity?.()).toBeUndefined();
  });

  it('defaults to system roots (null) with no TLS material and verify on', () => {
    buildGrpcCredentials(true);
    const [root, key, cert, opts] = createSsl.mock.calls[0]!;
    expect(root).toBeNull();
    expect(key).toBeNull();
    expect(cert).toBeNull();
    expect((opts as { checkServerIdentity?: unknown }).checkServerIdentity).toBeUndefined();
  });
});
