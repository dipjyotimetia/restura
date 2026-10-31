import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the options buildConnectTransport hands to connect-node — the TLS /
// compression / lookup mapping isn't observable through a live call.
const createGrpcTransportMock = vi.fn((_opts: unknown) => ({ kind: 'mock-transport' }));
const createConnectTransportMock = vi.fn((_opts: unknown) => ({ kind: 'mock-connect-transport' }));
const createGrpcWebTransportMock = vi.fn((_opts: unknown) => ({ kind: 'mock-grpc-web-transport' }));
vi.mock('@connectrpc/connect-node', () => ({
  createGrpcTransport: (opts: unknown) => createGrpcTransportMock(opts),
  createConnectTransport: (opts: unknown) => createConnectTransportMock(opts),
  createGrpcWebTransport: (opts: unknown) => createGrpcWebTransportMock(opts),
  compressionGzip: { name: 'gzip' },
}));

vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown) => (typeof v === 'string' ? v : undefined),
}));

import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import {
  buildConnectFallbackTransport,
  buildConnectTransport,
  type PinnedDial,
} from '../handlers/grpc-connect';
import { createPinnedTransport, type GrpcWireProtocolChoice } from '../handlers/grpc-wire-protocol';

interface CapturedOptions {
  baseUrl: string;
  httpVersion?: string;
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
  createConnectTransportMock.mockClear();
  createGrpcWebTransportMock.mockClear();
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

  // RFC 6066 forbids IP SNI and Node 26 throws ERR_INVALID_ARG_VALUE on it.
  it.each([['grpcs://10.0.0.5:50051'], ['grpcs://[2001:db8::1]:50051']])(
    'omits SNI for an IP-literal TLS target (%s)',
    (url) => {
      buildConnectTransport(url, DIAL);
      expect(lastOptions().nodeOptions.servername).toBeUndefined();
    }
  );

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

describe('response-size caps (SEC-G1)', () => {
  it('caps reads + writes on both transports at MAX_RESPONSE_SIZE (not the ~4 GiB default)', () => {
    buildConnectTransport('grpc://api.example.com:50051', DIAL);
    buildConnectFallbackTransport('grpc://api.example.com:50051', DIAL);
    const native = createGrpcTransportMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const fallback = createConnectTransportMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    for (const opts of [native, fallback]) {
      expect(opts.readMaxBytes).toBe(MAX_RESPONSE_SIZE);
      expect(opts.writeMaxBytes).toBe(MAX_RESPONSE_SIZE);
    }
  });
});

describe('pinned wire-protocol transports (#914) keep the response-size caps', () => {
  const base = {
    baseUrl: 'http://api.example.com:50051',
    nodeOptions: { lookup: () => {} },
    readMaxBytes: MAX_RESPONSE_SIZE,
    writeMaxBytes: MAX_RESPONSE_SIZE,
  };
  const mocks: Record<GrpcWireProtocolChoice, ReturnType<typeof vi.fn>> = {
    grpc: createGrpcTransportMock,
    connect: createConnectTransportMock,
    'grpc-web': createGrpcWebTransportMock,
  };

  for (const wireProtocol of ['grpc', 'connect', 'grpc-web'] as const) {
    it(`${wireProtocol}: forwards readMaxBytes / writeMaxBytes and the pinned dial`, () => {
      createPinnedTransport({ url: base.baseUrl, dial: DIAL, wireProtocol }, () => base);
      const opts = mocks[wireProtocol].mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(opts.readMaxBytes).toBe(MAX_RESPONSE_SIZE);
      expect(opts.writeMaxBytes).toBe(MAX_RESPONSE_SIZE);
      expect(opts.nodeOptions).toBe(base.nodeOptions);
      expect(opts.baseUrl).toBe(base.baseUrl);
    });
  }
});

describe('buildConnectFallbackTransport', () => {
  function lastConnectOptions(): CapturedOptions {
    const call = createConnectTransportMock.mock.calls.at(-1);
    if (!call) throw new Error('createConnectTransport was not called');
    return call[0] as unknown as CapturedOptions;
  }

  it('uses the Connect protocol over HTTP/2 with the same baseUrl', () => {
    buildConnectFallbackTransport('https://echo.restura.dev', { ...DIAL, port: 443 });
    const opts = lastConnectOptions();
    expect(opts.httpVersion).toBe('2');
    expect(opts.baseUrl).toBe('https://echo.restura.dev:443');
    expect(createGrpcTransportMock).not.toHaveBeenCalled();
  });

  it('carries the same pinned lookup and TLS material as the native transport', () => {
    buildConnectFallbackTransport('grpcs://api.example.com:50051', DIAL, {
      caCert: { pem: 'CA-PEM' },
      verifySsl: false,
      clientCert: { cert: 'CERT-PEM', key: 'KEY-PEM', passphrase: 'hunter2' },
    });
    const { nodeOptions } = lastConnectOptions();
    expect(nodeOptions.servername).toBe('api.example.com');
    expect(nodeOptions.ca).toBe('CA-PEM');
    expect(nodeOptions.rejectUnauthorized).toBe(false);
    expect(nodeOptions.cert).toBe('CERT-PEM');
    expect(nodeOptions.key).toBe('KEY-PEM');
    expect(nodeOptions.passphrase).toBe('hunter2');

    const all = vi.fn();
    nodeOptions.lookup('api.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: DIAL.ip, family: 4 }]);
    const single = vi.fn();
    nodeOptions.lookup('api.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, DIAL.ip, 4);
  });

  it('enables gzip send compression when useCompression is set', () => {
    buildConnectFallbackTransport('grpc://api.example.com:50051', DIAL, undefined, true);
    expect(lastConnectOptions().sendCompression).toEqual({ name: 'gzip' });
  });
});
