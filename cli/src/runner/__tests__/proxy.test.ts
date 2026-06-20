import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollection, type RunOptions } from '../runner';
import type { Reporter } from '../../reporters/types';

let upstream: Server;
let proxy: Server;
let upstreamUrl: string;
let proxyUrl: string;
let proxyHits = 0;

beforeAll(async () => {
  upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 200;
    res.end('upstream-ok');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  // undici's ProxyAgent tunnels via HTTP CONNECT (even for http origins), so
  // the proxy must establish a TCP tunnel rather than forward in absolute-form.
  proxy = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = 405;
    res.end('use CONNECT');
  });
  proxy.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    proxyHits++;
    const [host, portStr] = (req.url ?? '').split(':');
    const serverSocket = netConnect(Number(portStr), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => proxy.close(() => r()));
});

beforeEach(() => {
  proxyHits = 0;
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

function makeCollection(): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-proxy-'));
  const file = join(dir, 'c.yaml');
  writeFileSync(
    file,
    `opencollection: "1.0.0"\ninfo:\n  name: Proxy\n  version: "0.1.0"\nbundled: true\nitems:\n  - info: { type: http, name: Via, seq: 1 }\n    http: { method: GET, url: "${upstreamUrl}/r" }\n`,
    'utf-8'
  );
  return file;
}

function run(proxyOpt?: string) {
  const opts: RunOptions = {
    envVars: {},
    bail: false,
    timeoutMs: 5000,
    allowLocalhost: true,
    ...(proxyOpt ? { proxy: proxyOpt } : {}),
  };
  return runCollection(makeCollection(), opts, new NoopReporter());
}

describe('runCollection — explicit proxy', () => {
  it('routes the request through --proxy', async () => {
    const result = await run(proxyUrl);
    expect(result.requests[0]!.passed).toBe(true);
    expect(result.requests[0]!.status).toBe(200);
    expect(proxyHits).toBe(1);
  });

  it('connects directly when no proxy is set (proxy not hit)', async () => {
    const result = await run();
    expect(result.requests[0]!.passed).toBe(true);
    expect(proxyHits).toBe(0);
  });
});
