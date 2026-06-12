import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the options buildConnectTransport hands to connect-node — the TLS /
// compression / lookup mapping isn't observable through a live call.
const createGrpcTransportMock = vi.fn((_opts: unknown) => ({ kind: 'mock-transport' }));
vi.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: (opts: unknown) => createGrpcTransportMock(opts),
  compressionGzip: { name: 'gzip' },
}));

vi.mock('../secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) => (typeof v === 'string' ? v : undefined),
}));

import { buildConnectTransport, type PinnedDial } from '../grpc-connect';

interface CapturedOptions {
  baseUrl: string;
  nodeOptions: Record<string, unknown> & {
    lookup: (
      hostname: string,
      opts: { all?: boolean } | undefined,
      cb: (err: Error | null, address: unknown, family?: number) => void
    ) => void;
  };
  sendCompression?: { name: string };
}

const DIAL: PinnedDial = { ip: '93.184.216.34', port: 50051, family: 4 };

function lastOptions(): CapturedOptions {
  const call = createGrpcTransportMock.mock.calls.at(-1);
  if (!call) throw new Error('createGrpcTransport was not called');
  return call[0] as unknown as CapturedOptions;
}

beforeEach(() => {
  createGrpcTransportMock.mockClear();
});

describe('buildConnectTransport', () => {
  it('dials plaintext with the hostname in baseUrl and the pinned port', () => {
    buildConnectTransport('grpc://api.example.com:50051', DIAL);
    const opts = lastOptions();
    expect(opts.baseUrl).toBe('http://api.example.com:50051');
    expect(opts.nodeOptions.servername).toBeUndefined();
    expect(opts.sendCompression).toBeUndefined();
  });

  it('pins DNS to the pre-validated IP in both lookup callback shapes', () => {
    buildConnectTransport('grpc://api.example.com:50051', DIAL);
    const { lookup } = lastOptions().nodeOptions;

    // Node 24 net.connect shape: { all: true } → array of records.
    const all = vi.fn();
    lookup('api.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: DIAL.ip, family: 4 }]);

    // Positional shape: (err, address, family).
    const single = vi.fn();
    lookup('api.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, DIAL.ip, 4);
  });

  it('keeps SNI on the hostname and maps CA / verify toggle for TLS', () => {
    buildConnectTransport('grpcs://api.example.com:50051', DIAL, {
      caCert: { pem: 'CA-PEM' },
      verifySsl: false,
    });
    const { nodeOptions, baseUrl } = lastOptions();
    expect(baseUrl).toBe('https://api.example.com:50051');
    expect(nodeOptions.servername).toBe('api.example.com');
    expect(nodeOptions.ca).toBe('CA-PEM');
    expect(nodeOptions.rejectUnauthorized).toBe(false);
  });

  it('maps a PEM client cert + key + passphrase for mTLS', () => {
    buildConnectTransport('grpcs://api.example.com:50051', DIAL, {
      clientCert: { cert: 'CERT-PEM', key: 'KEY-PEM', passphrase: 'hunter2' },
    });
    const { nodeOptions } = lastOptions();
    expect(nodeOptions.cert).toBe('CERT-PEM');
    expect(nodeOptions.key).toBe('KEY-PEM');
    expect(nodeOptions.passphrase).toBe('hunter2');
    expect(nodeOptions.pfx).toBeUndefined();
  });

  it('maps a PFX bundle (base64 → Buffer) + passphrase for mTLS', () => {
    const pfxBytes = Buffer.from('pkcs12-bundle');
    buildConnectTransport('grpcs://api.example.com:50051', DIAL, {
      clientCert: { pfx: pfxBytes.toString('base64'), passphrase: 'hunter2' },
    });
    const { nodeOptions } = lastOptions();
    expect(Buffer.isBuffer(nodeOptions.pfx)).toBe(true);
    expect((nodeOptions.pfx as Buffer).equals(pfxBytes)).toBe(true);
    expect(nodeOptions.passphrase).toBe('hunter2');
    expect(nodeOptions.cert).toBeUndefined();
  });

  it('ignores client-cert material on a plaintext dial', () => {
    buildConnectTransport('grpc://api.example.com:50051', DIAL, {
      clientCert: { cert: 'CERT-PEM', key: 'KEY-PEM' },
      verifySsl: false,
    });
    const { nodeOptions } = lastOptions();
    expect(nodeOptions.cert).toBeUndefined();
    expect(nodeOptions.rejectUnauthorized).toBeUndefined();
  });

  it('enables gzip send compression when useCompression is set', () => {
    buildConnectTransport('grpc://api.example.com:50051', DIAL, undefined, true);
    expect(lastOptions().sendCompression).toEqual({ name: 'gzip' });
  });
});
