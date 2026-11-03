/**
 * MCP control server lifecycle + renderer bridge, end to end inside main:
 * real loopback listener, real SDK client, real handshake file — with the
 * renderer played by the test (it receives `mcp-control:tool-call` through the
 * mocked emitter and answers through the real `mcp-control:tool-result` IPC
 * handler, exactly as the preload bridge would).
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ToolCallEvent } from '@shared/mcp-server/control-bridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  userData: '',
  emitted: [] as Array<{ id: number; channel: string; payload: unknown }>,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getVersion: () => '1.2.3', isPackaged: true },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      h.handlers.set(channel, fn),
    removeHandler: (channel: string) => h.handlers.delete(channel),
  },
}));
vi.mock('../ipc/ipc-utils', () => ({
  emitTo: (id: number, channel: string, payload: unknown) =>
    h.emitted.push({ id, channel, payload }),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import {
  agentLaunchCommand,
  disposeMcpControlIPC,
  markStaleHandshakeStopped,
  registerMcpControlIPC,
  ToolCallBridge,
} from '../handlers/mcp-control-handler';
import { readHandshake, writeHandshake } from '../handlers/mcp-control-protocol';

const TRUSTED_FRAME = { url: 'file:///app/dist/web/index.html', parent: null };

function fakeWebContents(id: number) {
  const listeners = new Map<string, () => void>();
  return {
    id,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    once(event: string, fn: () => void) {
      listeners.set(event, fn);
    },
    on(event: string, fn: () => void) {
      listeners.set(event, fn);
    },
    removeListener(event: string) {
      listeners.delete(event);
    },
    emit(event: string) {
      listeners.get(event)?.();
    },
    destroy() {
      this.destroyed = true;
      listeners.get('destroyed')?.();
    },
  };
}

function invoke(channel: string, sender: ReturnType<typeof fakeWebContents>, ...args: unknown[]) {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({ sender, senderFrame: TRUSTED_FRAME }, ...args);
}

const clients: Client[] = [];
async function connect(url: string, token: string) {
  const client = new Client({ name: 'agent', version: '1' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
  );
  clients.push(client);
  return client;
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const toolCalls = () =>
  h.emitted.filter((e) => e.channel === 'mcp-control:tool-call') as Array<{
    id: number;
    channel: string;
    payload: ToolCallEvent;
  }>;

describe('mcp-control IPC lifecycle', () => {
  beforeEach(async () => {
    h.userData = await mkdtemp(path.join(tmpdir(), 'restura-mcp-control-'));
    h.emitted.length = 0;
    h.handlers.clear();
    registerMcpControlIPC();
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await disposeMcpControlIPC();
    await rm(h.userData, { recursive: true, force: true });
  });

  it('start → agent call → renderer answers → agent gets the result', async () => {
    const owner = fakeWebContents(7);
    const started = (await invoke('mcp-control:start', owner)) as {
      ok: true;
      status: { running: boolean; url: string; port: number };
      token: string;
    };
    expect(started.ok).toBe(true);
    expect(started.status.running).toBe(true);

    // Handshake written for the stdio shim, owner-only.
    const hs = await readHandshake(h.userData);
    expect(hs).toMatchObject({ running: true, port: started.status.port, token: started.token });
    if (process.platform !== 'win32') {
      expect((await stat(path.join(h.userData, 'mcp-control.json'))).mode & 0o777).toBe(0o600);
    }

    const client = await connect(started.status.url, started.token);
    const pending = client.callTool({ name: 'list_collections', arguments: {} });

    const call = await waitFor(() => toolCalls()[0]);
    expect(call.id).toBe(7);
    expect(call.payload.tool).toBe('list_collections');

    // A different renderer cannot answer someone else's call.
    const intruder = fakeWebContents(99);
    expect(
      await invoke('mcp-control:tool-result', intruder, {
        callId: call.payload.callId,
        result: { ok: true, data: { collections: ['forged'] } },
      })
    ).toEqual({ ok: false });

    expect(
      await invoke('mcp-control:tool-result', owner, {
        callId: call.payload.callId,
        result: { ok: true, data: { collections: [] } },
      })
    ).toEqual({ ok: true });

    const result = await pending;
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
      collections: [],
    });
    // Answering twice is a no-op.
    expect(
      await invoke('mcp-control:tool-result', owner, {
        callId: call.payload.callId,
        result: { ok: true, data: null },
      })
    ).toEqual({ ok: false });
  });

  it('rejects a malformed tool-result payload at the IPC boundary', async () => {
    const owner = fakeWebContents(1);
    await invoke('mcp-control:start', owner);
    await expect(
      invoke('mcp-control:tool-result', owner, { callId: 'not-a-uuid', result: { ok: true } })
    ).rejects.toThrow(/Invalid IPC payload/);
  });

  it('mints a fresh token on every start, keeps the port, and the old token stops working', async () => {
    const owner = fakeWebContents(1);
    const first = (await invoke('mcp-control:start', owner)) as {
      status: { port: number };
      token: string;
    };
    await invoke('mcp-control:stop', owner);
    expect(await readHandshake(h.userData)).toMatchObject({ running: false });

    const second = (await invoke('mcp-control:start', owner)) as {
      status: { port: number; url: string };
      token: string;
    };
    expect(second.token).not.toBe(first.token);
    expect(second.status.port).toBe(first.status.port);
    expect(await readHandshake(h.userData)).toMatchObject({ running: true, token: second.token });
    await expect(connect(second.status.url, first.token)).rejects.toThrow();
    await expect(connect(second.status.url, second.token)).resolves.toBeDefined();
  });

  it('marks a handshake left running by a crashed instance as stopped', async () => {
    await writeHandshake(h.userData, {
      version: 1,
      running: true,
      port: 4321,
      token: 'x'.repeat(43),
      pid: 999_999,
      updatedAt: 0,
    });
    await markStaleHandshakeStopped(h.userData);
    expect(await readHandshake(h.userData)).toMatchObject({ running: false, port: 4321 });
  });

  it('stopping cancels parked calls and tells the renderer to drop their cards', async () => {
    const owner = fakeWebContents(3);
    const started = (await invoke('mcp-control:start', owner)) as {
      status: { url: string };
      token: string;
    };
    const client = await connect(started.status.url, started.token);
    const pending = client.callTool({ name: 'describe_access', arguments: {} });
    const call = await waitFor(() => toolCalls()[0]);

    await invoke('mcp-control:stop', owner);
    const cancelled = h.emitted.find((e) => e.channel === 'mcp-control:tool-cancelled');
    expect(cancelled?.payload).toEqual({ callId: call.payload.callId });
    // The agent gets a clean tool error, not a dropped socket.
    const result = await pending;
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/turned off/);
  });

  it('the owner window closing stops the server', async () => {
    const owner = fakeWebContents(4);
    await invoke('mcp-control:start', owner);
    owner.destroy();
    const deadline = Date.now() + 2_000;
    let running = true;
    while (running && Date.now() < deadline) {
      const s = (await invoke('mcp-control:status', fakeWebContents(5))) as {
        status: { running: boolean };
      };
      running = s.status.running;
      if (running) await new Promise((r) => setTimeout(r, 10));
    }
    expect(running).toBe(false);
    await vi.waitFor(async () => expect((await readHandshake(h.userData))?.running).toBe(false));
  });

  it('refuses IPC from an untrusted frame', async () => {
    const fn = h.handlers.get('mcp-control:start')!;
    await expect(
      fn({ sender: fakeWebContents(1), senderFrame: { url: 'https://evil.example', parent: null } })
    ).rejects.toThrow(/untrusted frame/);
  });
});

describe('mcp-control renderer lifecycle', () => {
  beforeEach(async () => {
    h.userData = await mkdtemp(path.join(tmpdir(), 'restura-mcp-reload-'));
    h.emitted.length = 0;
    h.handlers.clear();
    registerMcpControlIPC();
  });
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    await disposeMcpControlIPC();
    await rm(h.userData, { recursive: true, force: true });
  });

  it.each(['did-navigate', 'render-process-gone'])(
    '%s answers parked calls at once and keeps the server for the reloaded page',
    async (event) => {
      const owner = fakeWebContents(8);
      const started = (await invoke('mcp-control:start', owner)) as {
        status: { url: string };
        token: string;
      };
      const client = await connect(started.status.url, started.token);
      const pending = client.callTool({ name: 'describe_access', arguments: {} });
      await waitFor(() => toolCalls()[0]);

      owner.emit(event);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/reloaded/);

      const status = (await invoke('mcp-control:status', owner)) as {
        status: { running: boolean; inFlight: number };
        token?: string;
      };
      expect(status.status).toMatchObject({ running: true, inFlight: 0 });
      // The adopting page gets the token for the HTTP config.
      expect(status.token).toBe(started.token);
    }
  );

  it('status works even when start/stop are rate-limited (separate budget)', async () => {
    const owner = fakeWebContents(9);
    for (let i = 0; i < 40; i += 1) {
      await invoke('mcp-control:status', owner);
    }
    await expect(invoke('mcp-control:stop', owner)).resolves.toMatchObject({ ok: true });
  });
});

describe('agentLaunchCommand', () => {
  it('uses the AppImage / portable launcher instead of the transient executable path', () => {
    expect(
      agentLaunchCommand(
        { APPIMAGE: '/home/u/Restura.AppImage' },
        true,
        ['/tmp/.mount_x/restura'],
        '/tmp/.mount_x/restura'
      )
    ).toEqual({ command: '/home/u/Restura.AppImage', args: ['--mcp-server'] });
    expect(
      agentLaunchCommand(
        { PORTABLE_EXECUTABLE_FILE: 'D:\\Restura.exe' },
        true,
        ['x'],
        'C:\\Temp\\x\\Restura.exe'
      ).command
    ).toBe('D:\\Restura.exe');
    expect(agentLaunchCommand({}, true, ['/opt/Restura/restura'], '/opt/Restura/restura')).toEqual({
      command: '/opt/Restura/restura',
      args: ['--mcp-server'],
    });
  });

  it('an unpackaged build passes its entry and a custom user data folder on', () => {
    expect(
      agentLaunchCommand(
        { RESTURA_USER_DATA_DIR: '/tmp/profile' },
        false,
        ['/repo/node_modules/electron/dist/electron', 'dist/electron/electron/main/main.js'],
        '/repo/node_modules/electron/dist/electron'
      )
    ).toEqual({
      command: '/repo/node_modules/electron/dist/electron',
      args: [path.resolve('dist/electron/electron/main/main.js'), '--mcp-server'],
      env: { RESTURA_USER_DATA_DIR: '/tmp/profile' },
    });
  });
});

describe('ToolCallBridge', () => {
  const emitted: Array<{ id: number; channel: string; payload: unknown }> = [];
  const emit = (id: number, channel: string, payload: unknown) =>
    emitted.push({ id, channel, payload });
  const signal = () => new AbortController().signal;

  beforeEach(() => {
    emitted.length = 0;
  });

  it('refuses when no renderer owns the server, and unknown tools', async () => {
    const bridge = new ToolCallBridge(emit);
    expect(
      await bridge.call({ tool: 'list_collections', input: {}, signal: signal() })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/not ready/) });
    bridge.setOwner(1);
    expect(await bridge.call({ tool: 'rm_rf', input: {}, signal: signal() })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Unknown tool/),
    });
    expect(emitted).toHaveLength(0);
  });

  it('times out, cancels on abort, and caps in-flight calls', async () => {
    vi.useFakeTimers();
    try {
      const bridge = new ToolCallBridge(emit, 1_000);
      bridge.setOwner(1);
      const timedOut = bridge.call({ tool: 'describe_access', input: {}, signal: signal() });
      vi.advanceTimersByTime(1_001);
      expect(await timedOut).toMatchObject({ ok: false, error: expect.stringMatching(/in time/) });
      expect(emitted.at(-1)?.channel).toBe('mcp-control:tool-cancelled');

      const ac = new AbortController();
      const aborted = bridge.call({ tool: 'describe_access', input: {}, signal: ac.signal });
      ac.abort();
      expect(await aborted).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/) });

      const parked = Array.from({ length: 16 }, () =>
        bridge.call({ tool: 'describe_access', input: {}, signal: signal() })
      );
      expect(bridge.inFlight).toBe(16);
      expect(
        await bridge.call({ tool: 'describe_access', input: {}, signal: signal() })
      ).toMatchObject({ ok: false, error: expect.stringMatching(/Too many/) });
      bridge.disposeAll('stopped');
      expect(await Promise.all(parked)).toEqual(
        Array.from({ length: 16 }, () => ({ ok: false, error: 'stopped' }))
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces an oversized renderer result with an error', async () => {
    const bridge = new ToolCallBridge(emit);
    bridge.setOwner(1);
    const pending = bridge.call({ tool: 'get_request', input: {}, signal: signal() });
    const callId = (emitted[0]!.payload as ToolCallEvent).callId;
    bridge.resolveFromRenderer(1, {
      callId,
      result: { ok: true, data: 'x'.repeat(2_100_000) },
    });
    expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/larger/) });
  });

  it('changing owner cancels the previous owner’s calls', async () => {
    const bridge = new ToolCallBridge(emit);
    bridge.setOwner(1);
    const pending = bridge.call({ tool: 'describe_access', input: {}, signal: signal() });
    bridge.setOwner(2);
    expect(await pending).toMatchObject({ ok: false });
  });
});
