/**
 * #901 security-review regressions for the CLI MCP session: DNS pre-flight on
 * every URL, refused redirects, bounded bodies, guarded legacy-SSE endpoints
 * and DELETE, pool isolation / eviction / disposal.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dns = vi.hoisted(() => ({ table: {} as Record<string, string> }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const address = dns.table[host];
    if (!address) throw new Error(`ENOTFOUND ${host}`);
    return [{ address, family: 4 }];
  }),
}));

import type { Reporter } from '../../reporters/types';
import { CliMcpSessionPool, createGuardedMcpFetch, openCliMcpSession } from '../mcpSession';
import { runCollection } from '../runner';

interface Rec {
  httpMethod: string;
  path: string;
  rpc?: string;
  session?: string;
  auth?: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => boolean;

const servers: Server[] = [];

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** Minimal streamable-http MCP server (legacy era) with per-test overrides. */
async function startStreamable(override?: Handler) {
  const records: Rec[] = [];
  let sessions = 0;
  const port = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const msg = body ? (JSON.parse(body) as { id?: number; method?: string }) : {};
      records.push({
        httpMethod: req.method ?? '',
        path: req.url ?? '',
        ...(msg.method ? { rpc: msg.method } : {}),
        ...(typeof req.headers['mcp-session-id'] === 'string'
          ? { session: req.headers['mcp-session-id'] }
          : {}),
        ...(typeof req.headers.authorization === 'string'
          ? { auth: req.headers.authorization }
          : {}),
      });
      if (override?.(req, res, body)) return;
      if (req.method === 'GET') return void res.writeHead(405).end();
      if (req.method === 'DELETE') return void res.writeHead(200).end();
      if (msg.id === undefined) return void res.writeHead(202).end();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      let payload: unknown;
      if (msg.method === 'initialize') {
        headers['mcp-session-id'] = `s${++sessions}`;
        payload = {
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1' },
          },
        };
      } else if (msg.method === 'server/discover') {
        payload = { error: { code: -32601, message: 'Method not found' } };
      } else {
        payload = { result: { ok: true } };
      }
      res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
    });
  });
  return { port, records, url: `http://127.0.0.1:${port}/mcp` };
}

/** A redirect target that records whether anything ever reached it. */
async function startTarget() {
  const hits: string[] = [];
  const port = await listen((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200).end();
  });
  return { hits, location: `http://127.0.0.1:${port}/stolen` };
}

/** Dispatcher that dials every hostname at 127.0.0.1 (the DNS mock stays "public"). */
function loopbackDispatcher(): Agent {
  return new Agent({
    connect: {
      lookup: (
        _host: string,
        opts: { all?: boolean },
        cb: (e: Error | null, a: unknown, f?: number) => void
      ) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)),
    } as never,
  });
}

beforeEach(() => {
  dns.table = {};
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('guarded MCP fetch', () => {
  it('refuses a hostname that resolves to a private address before connecting', async () => {
    dns.table['internal.example.test'] = '10.0.0.5';
    const fetch = createGuardedMcpFetch({ allowLocalhost: false });
    await expect(fetch('http://internal.example.test/mcp', { method: 'POST' })).rejects.toThrow(
      /private|internal|rejected|not allowed/i
    );
    await expect(
      openCliMcpSession({
        url: 'http://internal.example.test/mcp',
        transport: 'streamable-http',
        headers: {},
        allowLocalhost: false,
        timeoutMs: 2000,
      })
    ).rejects.toThrow();
  });

  it.each(['POST', 'GET'])('refuses a 3xx on %s without fetching Location', async (method) => {
    const target = await startTarget();
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: target.location }).end();
    });
    const fetch = createGuardedMcpFetch({ allowLocalhost: true });
    await expect(
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method,
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
    ).rejects.toThrow(/redirect/);
    expect(target.hits).toEqual([]);
  });

  it('caps a body by Content-Length and by streamed byte count', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/declared') {
        res.writeHead(200, { 'content-length': '5000' }).end('x'.repeat(5000));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('x'.repeat(600));
      res.end('y'.repeat(600));
    });
    const fetch = createGuardedMcpFetch({ allowLocalhost: true }, 1000);
    await expect(fetch(`http://127.0.0.1:${port}/declared`)).rejects.toThrow(/byte cap/);
    const streamed = await fetch(`http://127.0.0.1:${port}/stream`);
    await expect(streamed.text()).rejects.toThrow(/byte cap/);
  });

  it('passes a small body through unchanged', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    const res = await createGuardedMcpFetch({ allowLocalhost: true })(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('legacy http-sse endpoint guard', () => {
  async function startLegacy(
    endpoint: (port: number) => string,
    postStatus = 202,
    location = 'http://127.0.0.1:1/x'
  ) {
    const posts: string[] = [];
    const streams: string[] = [];
    const port = await listen((req, res) => {
      if (req.method === 'GET') {
        streams.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: endpoint\ndata: ${endpoint(port)}\n\n`);
        return;
      }
      posts.push(req.url ?? '');
      req.resume();
      res.writeHead(postStatus, postStatus >= 300 ? { location } : {});
      res.end();
    });
    return { port, posts, streams };
  }

  it.each([
    ['cloud metadata', () => 'http://169.254.169.254/messages'],
    ['loopback (allowLocalhost off)', (port: number) => `http://127.0.0.1:${port}/messages`],
  ])('rejects an announced %s endpoint without posting to it', async (_label, endpoint) => {
    dns.table['legacy.example.test'] = '93.184.216.34';
    const legacy = await startLegacy(endpoint);
    await expect(
      openCliMcpSession({
        url: `http://legacy.example.test:${legacy.port}/sse`,
        transport: 'http-sse',
        headers: {},
        allowLocalhost: false,
        timeoutMs: 2000,
        dispatcher: loopbackDispatcher(),
      })
    ).rejects.toThrow();
    // The stream itself was reachable; only the announced endpoint was refused.
    expect(legacy.streams).toContain('/sse');
    expect(legacy.posts).toEqual([]);
  });

  it('refuses a 3xx from the announced endpoint POST', async () => {
    const target = await startTarget();
    const legacy = await startLegacy(() => '/messages', 307, target.location);
    await expect(
      openCliMcpSession({
        url: `http://127.0.0.1:${legacy.port}/sse`,
        transport: 'http-sse',
        headers: {},
        allowLocalhost: true,
        timeoutMs: 2000,
      })
    ).rejects.toThrow();
    expect(legacy.posts.length).toBeGreaterThan(0);
    expect(target.hits).toEqual([]);
  });
});

describe('session lifecycle', () => {
  it('sends the terminating DELETE through the guard', async () => {
    const server = await startStreamable();
    const open = () =>
      openCliMcpSession({
        url: `http://mcp.example.test:${server.port}/mcp`,
        transport: 'streamable-http',
        headers: {},
        allowLocalhost: false,
        timeoutMs: 2000,
        dispatcher: loopbackDispatcher(),
      });

    dns.table['mcp.example.test'] = '93.184.216.34';
    const allowed = await open();
    await allowed.close();
    expect(server.records.filter((r) => r.httpMethod === 'DELETE')).toHaveLength(1);

    const rebound = await open();
    dns.table['mcp.example.test'] = '10.0.0.7'; // rebinds before teardown
    await rebound.close();
    expect(server.records.filter((r) => r.httpMethod === 'DELETE')).toHaveLength(1);
  });

  it('evicts a session after a transport failure so the next caller reconnects', async () => {
    const pool = new CliMcpSessionPool();
    const opened: number[] = [];
    const close = vi.fn(async () => {});
    const open = async () => {
      opened.push(opened.length);
      return { request: vi.fn(), close };
    };
    await pool.get('k', open);
    await pool.get('k', open);
    expect(opened).toHaveLength(1);
    pool.evict('k');
    pool.evict('missing');
    await pool.get('k', open);
    expect(opened).toHaveLength(2);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await pool.dispose();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

class NoopReporter implements Reporter {
  onEnd(): void {}
}

function collection(url: string, items: Array<{ name: string; auth?: string; method?: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'restura-mcp-guard-'));
  writeFileSync(join(dir, '_collection.yaml'), 'name: Guard\n', 'utf-8');
  items.forEach((item, i) => {
    writeFileSync(
      join(dir, `${i}.mcp.yaml`),
      [
        `name: ${item.name}`,
        `url: '${url}'`,
        'transport: streamable-http',
        `defaultMethod: ${item.method ?? 'tools/list'}`,
        ...(item.auth
          ? ['headers:', `  - { key: Authorization, value: '${item.auth}', enabled: true }`]
          : []),
        '',
      ].join('\n'),
      'utf-8'
    );
  });
  return dir;
}

const runOpts = { envVars: {}, bail: false, timeoutMs: 5000, allowLocalhost: true };

describe('restura run — MCP pool', () => {
  it('isolates sessions by Authorization (no shared Mcp-Session-Id)', async () => {
    const server = await startStreamable();
    const dir = collection(server.url, [
      { name: 'Alice', auth: 'Bearer alice' },
      { name: 'Bob', auth: 'Bearer bob' },
      { name: 'Alice again', auth: 'Bearer alice' },
    ]);
    const result = await runCollection(dir, runOpts, new NoopReporter());
    expect(result.summary.passed).toBe(3);
    const calls = server.records.filter((r) => r.rpc === 'tools/list');
    const sessionFor = (auth: string) =>
      new Set(calls.filter((c) => c.auth === auth).map((c) => c.session));
    expect(server.records.filter((r) => r.rpc === 'initialize')).toHaveLength(2);
    expect([...sessionFor('Bearer alice')]).toHaveLength(1);
    expect([...sessionFor('Bearer bob')]).toHaveLength(1);
    expect([...sessionFor('Bearer alice')][0]).not.toBe([...sessionFor('Bearer bob')][0]);
  });

  it('reconnects after a transport-level failure instead of reusing the broken session', async () => {
    let failed = false;
    const server = await startStreamable((req, res, body) => {
      if (req.method === 'POST' && !failed && body.includes('"tools/list"')) {
        failed = true;
        res.writeHead(500).end('boom');
        return true;
      }
      return false;
    });
    const dir = collection(server.url, [{ name: 'First' }, { name: 'Second' }]);
    const result = await runCollection(dir, runOpts, new NoopReporter());
    expect(result.requests[0]?.passed).toBe(false);
    expect(result.requests[1]?.passed).toBe(true);
    expect(server.records.filter((r) => r.rpc === 'initialize')).toHaveLength(2);
  });

  it('disposes pooled sessions when the run throws', async () => {
    const server = await startStreamable();
    const dir = collection(server.url, [{ name: 'Only' }]);
    await expect(
      runCollection(dir, runOpts, {
        onRequestComplete: () => {
          throw new Error('reporter blew up');
        },
        onEnd() {},
      })
    ).rejects.toThrow('reporter blew up');
    await vi.waitFor(() =>
      expect(server.records.filter((r) => r.httpMethod === 'DELETE')).toHaveLength(1)
    );
  });
});
