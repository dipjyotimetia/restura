/**
 * `Restura --mcp-server` stdio shim: an agent connects over stdio (here, an
 * in-memory linked pair), the shim reads the handshake file and relays every
 * call to the running app's loopback control server (a real one, with a fake
 * renderer dispatcher behind it).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport, ProtocolError } from '@modelcontextprotocol/client';
import { CONTROL_TOOLS } from '@shared/mcp-server/control-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stdioState = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  factory: undefined as (() => unknown) | undefined,
  options: undefined as { legacy?: string } | undefined,
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: vi.fn((factory: () => unknown, options: { legacy?: string }) => {
    stdioState.factory = factory;
    stdioState.options = options;
    return { close: stdioState.close };
  }),
}));

import { mintToken, writeHandshake } from '../handlers/mcp-control-protocol';
import {
  type ControlHttpServerHandle,
  type ControlToolCall,
  startControlHttpServer,
} from '../handlers/mcp-control-server';
import {
  APP_NOT_RUNNING_MESSAGE,
  createShimRelay,
  createShimServer,
  isConnectionRefused,
  type RemoteSessionFactory,
  startStdioMcpServer,
} from '../handlers/mcp-server-handler';

const IDENTITY = { name: 'restura', version: '1.0.0' };
let dir: string;
const cleanups: Array<() => Promise<unknown>> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'restura-shim-'));
});

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
  stdioState.close.mockClear();
  stdioState.factory = undefined;
});

async function agentOver(relay: ReturnType<typeof createShimRelay>) {
  const server = createShimServer(IDENTITY, relay.relay);
  const client = new Client({ name: 'claude-code', version: '2.1.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(
    () => client.close(),
    () => server.close(),
    () => relay.close()
  );
  return client;
}

async function runningApp(dispatch: (call: ControlToolCall) => Promise<unknown>) {
  const token = mintToken();
  const handle: ControlHttpServerHandle = await startControlHttpServer({
    identity: IDENTITY,
    getToken: () => token,
    dispatch: dispatch as never,
  });
  cleanups.push(() => handle.close());
  await writeHandshake(dir, {
    version: 1,
    running: true,
    port: handle.port,
    token,
    pid: process.pid,
    updatedAt: Date.now(),
  });
  return { handle, token };
}

const text = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;

describe('stdio shim', () => {
  it('exposes the same catalogue as the app, even before the app is running', async () => {
    const client = await agentOver(createShimRelay({ identity: IDENTITY, userDataDir: dir }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(CONTROL_TOOLS.map((t) => t.name).sort());
  });

  it('tells the agent what to do when Restura is not running', async () => {
    const client = await agentOver(createShimRelay({ identity: IDENTITY, userDataDir: dir }));
    const result = await client.callTool({ name: 'describe_access', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(APP_NOT_RUNNING_MESSAGE);
  });

  it('treats a stopped server or a dead pid as not running', async () => {
    await writeHandshake(dir, {
      version: 1,
      running: false,
      port: 1234,
      token: mintToken(),
      pid: process.pid,
      updatedAt: 0,
    });
    const connect = vi.fn<RemoteSessionFactory>();
    const client = await agentOver(
      createShimRelay({ identity: IDENTITY, userDataDir: dir, connect })
    );
    expect(text(await client.callTool({ name: 'describe_access', arguments: {} }))).toBe(
      APP_NOT_RUNNING_MESSAGE
    );
    await writeHandshake(dir, {
      version: 1,
      running: true,
      port: 1234,
      token: mintToken(),
      pid: 999_999,
      updatedAt: 0,
    });
    const deadPid = await agentOver(
      createShimRelay({ identity: IDENTITY, userDataDir: dir, connect, isAlive: () => false })
    );
    expect(text(await deadPid.callTool({ name: 'describe_access', arguments: {} }))).toBe(
      APP_NOT_RUNNING_MESSAGE
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('relays end to end to the running app and labels the stdio client', async () => {
    const dispatch = vi.fn(async (call: ControlToolCall) => ({
      ok: true as const,
      data: { echoed: call.input, client: call.client?.name },
    }));
    await runningApp(dispatch);
    const client = await agentOver(createShimRelay({ identity: IDENTITY, userDataDir: dir }));

    const result = await client.callTool({
      name: 'get_collection_tree',
      arguments: { collectionId: 'c-42' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({
      echoed: { collectionId: 'c-42' },
      client: 'claude-code/2.1.0 (stdio)',
    });
    // Second call reuses the session.
    await client.callTool({ name: 'describe_access', arguments: {} });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('picks up a restarted app (new port + rotated token) without restarting the shim', async () => {
    const first = await runningApp(async () => ({ ok: true, data: 'first' }));
    const client = await agentOver(createShimRelay({ identity: IDENTITY, userDataDir: dir }));
    expect(text(await client.callTool({ name: 'describe_access', arguments: {} }))).toBe('"first"');

    await first.handle.close();
    await runningApp(async () => ({ ok: true, data: 'second' }));
    expect(text(await client.callTool({ name: 'describe_access', arguments: {} }))).toBe(
      '"second"'
    );
  });

  it('retries once when the connection was refused (nothing was sent)', async () => {
    await writeHandshake(dir, {
      version: 1,
      running: true,
      port: 1,
      token: mintToken(),
      pid: process.pid,
      updatedAt: 0,
    });
    const refused = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const callTool = vi.fn().mockRejectedValue(refused);
    const connect = vi.fn<RemoteSessionFactory>(async () => ({
      callTool,
      close: async () => undefined,
    }));
    const client = await agentOver(
      createShimRelay({ identity: IDENTITY, userDataDir: dir, connect })
    );
    const result = await client.callTool({ name: 'describe_access', arguments: {} });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(text(result)).toBe(APP_NOT_RUNNING_MESSAGE);
  });

  it('never retries an ambiguous failure — send_request is not idempotent', async () => {
    await writeHandshake(dir, {
      version: 1,
      running: true,
      port: 1,
      token: mintToken(),
      pid: process.pid,
      updatedAt: 0,
    });
    const callTool = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const connect = vi.fn<RemoteSessionFactory>(async () => ({
      callTool,
      close: async () => undefined,
    }));
    const client = await agentOver(
      createShimRelay({ identity: IDENTITY, userDataDir: dir, connect })
    );
    const result = await client.callTool({
      name: 'send_request',
      arguments: { requestId: 'r1' },
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/may or may not have completed/);
  });

  it('passes a JSON-RPC error from the app through without retrying', async () => {
    await writeHandshake(dir, {
      version: 1,
      running: true,
      port: 1,
      token: mintToken(),
      pid: process.pid,
      updatedAt: 0,
    });
    const callTool = vi.fn().mockRejectedValue(new ProtocolError(-32602, 'bad args'));
    const connect = vi.fn<RemoteSessionFactory>(async () => ({
      callTool,
      close: async () => undefined,
    }));
    const client = await agentOver(
      createShimRelay({ identity: IDENTITY, userDataDir: dir, connect })
    );
    const result = await client.callTool({ name: 'describe_access', arguments: {} });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/bad args/);
  });

  it('isConnectionRefused walks the cause chain', () => {
    expect(isConnectionRefused({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isConnectionRefused({ cause: { cause: { code: 'ECONNREFUSED' } } })).toBe(true);
    expect(isConnectionRefused({ code: 'ECONNRESET' })).toBe(false);
    expect(isConnectionRefused(undefined)).toBe(false);
  });

  it('serves stdio through the v2 compatibility transport with isolated server instances', async () => {
    const handle = startStdioMcpServer({ identity: IDENTITY, userDataDir: dir });
    expect(stdioState.options).toMatchObject({ legacy: 'serve' });
    expect(stdioState.factory).toBeTypeOf('function');
    expect(stdioState.factory?.()).not.toBe(stdioState.factory?.());
    await handle.stop();
    expect(stdioState.close).toHaveBeenCalledOnce();
  });
});
