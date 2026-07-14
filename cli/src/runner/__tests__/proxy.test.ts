import { mkdtempSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo, connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Reporter } from '../../reporters/types';
import { type RunOptions, runCollection } from '../runner';

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

  // Since undici 8.6, ProxyAgent forwards plain-http origins in absolute-form
  // (a standard forward proxy) and only tunnels https origins via CONNECT. The
  // mock proxy therefore handles both shapes: replay absolute-form requests to
  // the upstream, and establish a TCP tunnel for CONNECT.
  proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
    proxyHits++;
    const target = new URL(req.url ?? '');
    const upstreamReq = httpRequest(
      {
        method: req.method,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstreamReq.on('error', () => res.destroy());
    req.pipe(upstreamReq);
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
