// @vitest-environment node
//
// NTLM (MS-NLMP) desktop handshake security regressions (#1069).
//
// NTLM authenticates a connection, so the Electron fetcher runs the
// type 1 → type 2 → type 3 handshake on ONE pinned socket. These tests drive
// the real fetcher against a recording upstream and assert:
//   1. the first request carries only a type 1 NEGOTIATE — no credential
//      material of any kind goes out before a type 2 challenge arrives;
//   2. the type 3 AUTHENTICATE travels on the socket that got the challenge;
//   3. if that socket does not survive the challenge, the request fails
//      explicitly and NO type 3 is ever sent on another connection;
//   4. credentials are bound to the requested origin — a redirect to another
//      origin gets no NTLM header;
//   5. a non-NTLM 401 is returned untouched; an HTTP/2 requirement fails loudly.
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { HttpVersionPreference } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('../../electron/main/security/env-proxy', () => ({ resolveEnvProxy: () => undefined }));

import { startMockProxyServer } from '../../e2e/mocks/proxyServer';
import {
  buildElectronFetcher,
  type HttpRequestConfig,
} from '../../electron/main/handlers/http-handler';
import { NTLM_AFFINITY_ERROR, ntlmFetchAuthFor } from '../../electron/main/handlers/ntlm-handshake';

const USER = 'alice';
const PASSWORD = 'Ntlm-pa55-s3cret';

// A syntactically valid type 2 challenge (UNICODE | NTLM | TARGET_INFO, EOL-only target info).
const TYPE2 = (() => {
  const msg = Buffer.alloc(52);
  msg.write('NTLMSSP\0', 0, 'latin1');
  msg.writeUInt32LE(2, 8);
  msg.writeUInt32LE(0x00800201, 20);
  msg.write('0123456789abcdef', 24, 'hex');
  msg.writeUInt16LE(4, 40);
  msg.writeUInt16LE(4, 42);
  msg.writeUInt32LE(48, 44);
  return msg.toString('base64');
})();

interface Seen {
  socket: number;
  authorization: string | undefined;
  /** NTLMSSP message type, when the Authorization header carries one. */
  ntlmType?: number;
  rawHeaders: string[];
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise<void>((r) => s.close(() => r()));
    })
  );
});

async function upstream(
  handle: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const socketIds = new WeakMap<Socket, number>();
  let nextSocket = 0;
  const server = http.createServer((req, res) => {
    if (!socketIds.has(req.socket)) socketIds.set(req.socket, ++nextSocket);
    const authorization = req.headers.authorization;
    const m = /^NTLM\s+(\S+)$/i.exec(authorization ?? '');
    const decoded = m ? Buffer.from(m[1]!, 'base64') : undefined;
    const entry: Seen = {
      socket: socketIds.get(req.socket)!,
      authorization,
      ...(decoded && decoded.length >= 12 ? { ntlmType: decoded.readUInt32LE(8) } : {}),
      rawHeaders: req.rawHeaders,
    };
    seen.push(entry);
    req.resume();
    req.on('end', () => handle(req, res, entry));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** IIS-like: challenge type 1, accept any type 3 on the challenged socket. */
function ntlmServer(onChallenge?: (res: http.ServerResponse, req: http.IncomingMessage) => void) {
  const challenged = new WeakSet<Socket>();
  return (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => {
    if (seen.ntlmType === 1) {
      challenged.add(req.socket);
      res.writeHead(401, { 'www-authenticate': `NTLM ${TYPE2}`, 'content-type': 'text/plain' });
      res.end('challenge');
      onChallenge?.(res, req);
      return;
    }
    if (seen.ntlmType === 3 && challenged.has(req.socket)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('authenticated');
      return;
    }
    res.writeHead(401, { 'www-authenticate': 'NTLM' });
    res.end('denied');
  };
}

async function send(
  url: string,
  opts: { httpVersion?: HttpVersionPreference; proxy?: HttpRequestConfig['proxy'] } = {}
) {
  const fetcher = buildElectronFetcher(
    { method: 'GET', url, verifySsl: true, ...opts } as HttpRequestConfig,
    { origin: new URL(url).origin, credentials: { username: USER, password: PASSWORD } }
  );
  return executeHttpProxy({ method: 'GET', url }, fetcher, { allowLocalhost: true });
}

function errorOf(result: Awaited<ReturnType<typeof send>>): string {
  return result.ok ? '' : String(result.payload.error);
}

function credentialForms(): Buffer[] {
  return ['utf8', 'utf16le', 'latin1'].flatMap((enc) => [
    Buffer.from(PASSWORD, enc as BufferEncoding),
    Buffer.from(USER, enc as BufferEncoding),
  ]);
}

describe('NTLM desktop handshake', () => {
  it('sends only a credential-free type 1 before the challenge, then type 3 on the same socket', async () => {
    const { url, seen } = await upstream(ntlmServer());
    const result = await send(`${url}/x`);
    expect(result.ok && result.response.status).toBe(200);

    expect(seen.map((s) => s.ntlmType)).toEqual([1, 3]);
    // Leg 1 carries a NEGOTIATE only: no username/password in any encoding,
    // in the Authorization header or anywhere else in the request head.
    const head = Buffer.from(seen[0]!.rawHeaders.join('\n'), 'utf8');
    const type1 = Buffer.from(seen[0]!.authorization!.slice(5), 'base64');
    for (const form of credentialForms()) {
      expect(type1.includes(form)).toBe(false);
      expect(head.includes(form)).toBe(false);
    }
    // Connection affinity: type 3 answered on the challenged socket.
    expect(seen[1]!.socket).toBe(seen[0]!.socket);
    // The type 3 proof never contains the password itself.
    const type3 = Buffer.from(seen[1]!.authorization!.slice(5), 'base64');
    for (const enc of ['utf8', 'utf16le', 'latin1'] as const) {
      expect(type3.includes(Buffer.from(PASSWORD, enc))).toBe(false);
    }
  });

  it('fails explicitly, without sending type 3, when the challenge closes the connection', async () => {
    const { url, seen } = await upstream((req, res, s) => {
      if (s.ntlmType === 1) {
        res.writeHead(401, { 'www-authenticate': `NTLM ${TYPE2}`, connection: 'close' });
        res.end();
        return;
      }
      ntlmServer()(req, res, s);
    });
    const result = await send(`${url}/x`);
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toContain(NTLM_AFFINITY_ERROR);
    expect(seen.map((s) => s.ntlmType)).toEqual([1]);
  });

  it('never moves type 3 to a new connection when the server drops the socket silently', async () => {
    const { url, seen } = await upstream(
      ntlmServer((res, req) => res.on('finish', () => req.socket.destroy()))
    );
    const result = await send(`${url}/x`);
    expect(result.ok).toBe(false);
    // Either undici notices the dead socket, or the pin refuses the reconnect.
    expect(errorOf(result)).toMatch(/NTLM handshake failed|other side closed|ECONNRESET/);
    expect(seen.filter((s) => s.ntlmType === 3)).toEqual([]);
    expect(new Set(seen.map((s) => s.socket)).size).toBe(1);
  });

  it('binds credentials to the requested origin across redirects', async () => {
    const other = await upstream((_req, res) => {
      res.writeHead(200);
      res.end('elsewhere');
    });
    // The NTLM-bound origin redirects (unauthenticated) to another origin.
    const redirecting = await upstream((_req, res) => {
      res.writeHead(302, { location: `${other.url}/landing` });
      res.end();
    });
    const fetcher = buildElectronFetcher(
      { method: 'GET', url: redirecting.url, verifySsl: true } as HttpRequestConfig,
      {
        origin: new URL(redirecting.url).origin,
        credentials: { username: USER, password: PASSWORD },
      }
    );
    const result = await executeHttpProxy(
      { method: 'GET', url: `${redirecting.url}/go` },
      fetcher,
      {
        allowLocalhost: true,
      }
    );
    expect(result.ok && result.response.status).toBe(200);
    expect(redirecting.seen[0]!.ntlmType).toBe(1);
    expect(other.seen).toHaveLength(1);
    expect(other.seen[0]!.authorization).toBeUndefined();
  });

  it('returns a non-NTLM 401 untouched after a single request', async () => {
    const { url, seen } = await upstream((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' });
      res.end('basic only');
    });
    const result = await send(`${url}/x`);
    expect(result.ok && result.response.status).toBe(401);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ntlmType).toBe(1);
  });

  it('refuses a required HTTP/2 connection instead of silently downgrading', async () => {
    const { url, seen } = await upstream(ntlmServer());
    const result = await send(`${url}/x`, { httpVersion: 'http2' });
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toMatch(/NTLM authentication requires HTTP\/1\.1/);
    expect(seen).toHaveLength(0);
  });
  it('fails explicitly on a challenge body over 1 MiB, before any type 3', async () => {
    const { url, seen } = await upstream((req, res, s) => {
      if (s.ntlmType === 1) {
        res.writeHead(401, { 'www-authenticate': `NTLM ${TYPE2}` });
        res.end(Buffer.alloc(2 * 1024 * 1024, 0x61));
        return;
      }
      ntlmServer()(req, res, s);
    });
    const result = await send(`${url}/x`);
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toMatch(/exceeds 1 MiB/);
    expect(seen.filter((s) => s.ntlmType === 3)).toEqual([]);
  });

  it.each([
    ['base64 garbage', 'NTLM AAAA'],
    [
      'out-of-bounds target info',
      (() => {
        const msg = Buffer.from(TYPE2, 'base64');
        msg.writeUInt32LE(0xffff, 44);
        return `NTLM ${msg.toString('base64')}`;
      })(),
    ],
  ])('rejects a hostile type 2 (%s) without sending type 3', async (_name, challenge) => {
    const { url, seen } = await upstream((_req, res) => {
      res.writeHead(401, { 'www-authenticate': challenge });
      res.end();
    });
    const result = await send(`${url}/x`);
    expect(result.ok).toBe(false);
    expect(errorOf(result)).toMatch(/NTLM challenge/);
    expect(seen).toHaveLength(1);
  });

  it('CONNECT-tunnels an http: target through an HTTP proxy so the pinned socket reaches the origin', async () => {
    const proxy = await startMockProxyServer();
    try {
      const { url, seen } = await upstream(ntlmServer());
      const result = await send(`${url}/x`, {
        proxy: { enabled: true, type: 'http', host: '127.0.0.1', port: proxy.port },
      });
      expect(result.ok && result.response.status).toBe(200);
      expect(proxy.connectCount()).toBe(1);
      expect(proxy.forwardCount()).toBe(0);
      expect(seen.map((s) => s.ntlmType)).toEqual([1, 3]);
      expect(seen[1]!.socket).toBe(seen[0]!.socket);
    } finally {
      await proxy.close();
    }
  });

  it('refuses an unresolvable keychain password instead of trying an empty one', () => {
    expect(() =>
      ntlmFetchAuthFor(
        { type: 'ntlm', ntlm: { username: USER, password: { kind: 'handle', id: 'missing' } } },
        'http://127.0.0.1/x'
      )
    ).toThrow();
  });
});
