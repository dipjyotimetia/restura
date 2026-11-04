// @vitest-environment node
/**
 * DNS-rebinding TOCTOU on the self-host Node server. The SSRF guard resolves
 * the upstream name and validates every address; the dial must then use the
 * address that was validated, not re-resolve. Simulated rebinding: the
 * guard-time resolution (`dns/promises`) answers a public IP on its first call
 * and loopback afterwards, and the connect-time resolver (`dns.lookup`, what
 * `net.connect` / undici use by default) answers loopback. An "internal"
 * server on 127.0.0.1 counts TCP connections; it must never see one.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { NODE_DEPS_FOR_TEST } from './node-deps-fixture';

const require = createRequire(import.meta.url);
const dnsCb = require('node:dns') as typeof import('node:dns');

const REBIND_HOST = 'rebind.test';
const PUBLIC_IP = '93.184.216.34';

let promisesCalls = 0;
const origCbLookup = dnsCb.lookup;
const origPromisesLookup = dnsCb.promises.lookup;

let internal: net.Server;
let internalPort = 0;
let internalConnections = 0;

beforeAll(async () => {
  internal = net.createServer((socket) => {
    internalConnections++;
    socket.on('error', () => {});
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 15\r\nconnection: close\r\n\r\nINTERNAL-SECRET');
  });
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
  internalPort = (internal.address() as net.AddressInfo).port;

  // biome-ignore lint/suspicious/noExplicitAny: patching Node's overloaded lookup
  (dnsCb as any).lookup = (host: string, opts: any, cb?: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const options = typeof opts === 'function' ? {} : (opts ?? {});
    if (host === REBIND_HOST) {
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(null, '127.0.0.1', 4);
      return;
    }
    // biome-ignore lint/suspicious/noExplicitAny: passthrough
    (origCbLookup as any)(host, opts, cb);
  };
  // biome-ignore lint/suspicious/noExplicitAny: patching Node's overloaded lookup
  (dnsCb.promises as any).lookup = async (host: string, opts?: any) => {
    if (host === REBIND_HOST) {
      promisesCalls++;
      const address = promisesCalls === 1 ? PUBLIC_IP : '127.0.0.1';
      return opts?.all ? [{ address, family: 4 }] : { address, family: 4 };
    }
    // biome-ignore lint/suspicious/noExplicitAny: passthrough
    return (origPromisesLookup as any)(host, opts);
  };
  syncBuiltinESMExports();
});

afterAll(async () => {
  dnsCb.lookup = origCbLookup;
  dnsCb.promises.lookup = origPromisesLookup;
  syncBuiltinESMExports();
  await new Promise<void>((r) => internal.close(() => r()));
});

beforeEach(() => {
  promisesCalls = 0;
  internalConnections = 0;
});

afterEach(() => {
  expect(internalConnections).toBe(0);
});

const app = createApp(NODE_DEPS_FOR_TEST);
const ENV = { WORKER_PROXY_TOKEN: 'tok' };

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(
    `http://localhost${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-restura-proxy-token': 'tok' },
      body: JSON.stringify(body),
    },
    { ...ENV }
  );
}

describe('self-host Node upstream dials are pinned to the validated address', () => {
  const U = () => `http://${REBIND_HOST}:${internalPort}/svc`;

  it.each([
    ['/api/proxy', () => ({ method: 'GET', url: U(), headers: {}, bodyType: 'none' })],
    [
      '/api/proxy (streaming)',
      () => ({
        method: 'GET',
        url: U(),
        headers: { Accept: 'text/event-stream' },
        bodyType: 'none',
      }),
    ],
    ['/api/grpc', () => ({ url: U(), service: 'a.B', method: 'C', message: {} })],
    ['/api/grpc/reflection', () => ({ url: U(), request: { listServices: '' } })],
    ['/api/grpc-web', () => ({ url: U(), service: 'a.B', method: 'C', message: 'AA==' })],
    [
      '/api/mcp',
      () => ({ url: U(), transport: 'streamable-http', jsonRpc: { id: 1, method: 'ping' } }),
    ],
    ['/api/mcp/terminate', () => ({ url: U(), transport: 'streamable-http', sessionId: 's1' })],
    [
      '/api/import/fetch',
      () => ({ url: `https://${REBIND_HOST}:${internalPort}/collection.json` }),
    ],
  ])('%s never reaches the rebound internal address', async (label, body) => {
    const res = await post(label.split(' ')[0]!, body());
    const text = await res.text();
    expect(text).not.toContain('INTERNAL-SECRET');
  });

  it('/api/proxy with an upstream proxy never dials a rebound proxy host', async () => {
    const res = await post('/api/proxy', {
      method: 'GET',
      url: `http://${PUBLIC_IP}/`,
      headers: {},
      bodyType: 'none',
      // The pinned dial goes to the (unreachable here) public address; stop early.
      timeout: 500,
      upstreamProxy: { host: REBIND_HOST, port: internalPort },
    });
    const text = await res.text();
    expect(text).not.toContain('INTERNAL-SECRET');
  });
});
