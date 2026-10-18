// @vitest-environment node
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IpcUtils from '../ipc/ipc-utils';

/**
 * Integration test for the desktop-only MCP stdio transport (#854): the real
 * IPC handler, the real SDK `StdioClientTransport` (cross-spawn, shell:false)
 * and a real stdio MCP server process (e2e-electron/fixtures/mcp-stdio-server.mjs).
 * Only `electron` (ipcMain + the native consent dialog) and the event emitter
 * are mocked. Every test proves the child PID is gone after teardown.
 */

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockShowMessageBox = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  dialog: { showMessageBox: mockShowMessageBox },
  BrowserWindow: { fromWebContents: () => null },
}));
vi.mock('../ipc/ipc-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcUtils>();
  return { ...actual, emitTo: mockEmitTo };
});

import { registerMcpHandlerIPC, stopMcpCleanup } from '../handlers/mcp-handler';
import { liveStdioChildCount } from '../handlers/mcp-stdio-session';
import {
  __setStdioConsentStoreForTests,
  type ConsentStoreShape,
} from '../security/mcp-stdio-consent';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<Record<string, unknown>>;

const FIXTURE = path.resolve(__dirname, '../../../e2e-electron/fixtures/mcp-stdio-server.mjs');
const ALWAYS = 2;
const CANCEL = 0;

const registered = new Map<string, IpcHandler>();
function handlerFor(channel: string): IpcHandler {
  const handler = registered.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler;
}

function memoryConsentStore(): ConsentStoreShape {
  const data: Record<string, { approvedAt: number; command: string }> = {};
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
    },
    has: (k) => k in data,
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    get store() {
      return data;
    },
  };
}

let nextSenderId = 100;
function makeEvent() {
  const sender = Object.assign(new EventEmitter(), {
    id: nextSenderId++,
    isDestroyed: () => false,
  });
  return { sender, senderFrame: { url: 'file:///app/dist/web/index.html' } };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

function stdioPayload(connectionId: string, extra: Record<string, unknown> = {}) {
  return {
    connectionId,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    cwd: path.dirname(FIXTURE),
    ...extra,
  };
}

async function callText(
  event: ReturnType<typeof makeEvent>,
  connectionId: string,
  name: string
): Promise<string> {
  const res = await handlerFor('mcp:request')(event, {
    connectionId,
    method: 'tools/call',
    params: { name, arguments: {} },
  });
  expect(res.success).toBe(true);
  return (res.result as { content: Array<{ text: string }> }).content[0]!.text;
}

describe('MCP stdio transport (real process)', () => {
  let tmp: string;

  beforeAll(() => {
    registerMcpHandlerIPC();
    for (const [channel, handler] of mockHandle.mock.calls) {
      registered.set(channel as string, handler as IpcHandler);
    }
  });

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'mcp-stdio-'));
    __setStdioConsentStoreForTests(memoryConsentStore());
    mockShowMessageBox.mockResolvedValue({ response: ALWAYS, checkboxChecked: false });
  });

  afterEach(async () => {
    await stopMcpCleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  afterAll(() => {
    __setStdioConsentStoreForTests(null);
  });

  it('prompts once, connects, calls tools, and kills the child on disconnect', async () => {
    const event = makeEvent();
    const res = await handlerFor('mcp:connect')(event, stdioPayload('s-1'));
    expect(res).toEqual({ success: true });
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(mockEmitTo).toHaveBeenCalledWith(event.sender.id, 'mcp:open:s-1');

    expect(await callText(event, 's-1', 'pid')).toMatch(/^\d+$/);
    const pid = Number(await callText(event, 's-1', 'pid'));
    expect(isAlive(pid)).toBe(true);

    // stderr is surfaced (bounded) on the per-connection channel.
    await vi.waitFor(() =>
      expect(mockEmitTo).toHaveBeenCalledWith(
        event.sender.id,
        'mcp:stderr:s-1',
        expect.objectContaining({ text: expect.stringContaining('fixture ready') })
      )
    );

    await handlerFor('mcp:disconnect')(event, { connectionId: 's-1' });
    expect(await waitUntilGone(pid)).toBe(true);
    await vi.waitFor(() => expect(liveStdioChildCount()).toBe(0));

    // "Always allow" persisted: the identical launch does not prompt again.
    const again = await handlerFor('mcp:connect')(event, stdioPayload('s-1'));
    expect(again).toEqual({ success: true });
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
  });

  it('a denied launch never spawns a process', async () => {
    mockShowMessageBox.mockResolvedValue({ response: CANCEL, checkboxChecked: false });
    const marker = path.join(tmp, 'spawned.txt');
    const event = makeEvent();
    const res = await handlerFor('mcp:connect')(
      event,
      stdioPayload('s-deny', { env: { MCP_STDIO_FIXTURE_MARKER: marker } })
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not approved/);
    expect(existsSync(marker)).toBe(false);
    expect(liveStdioChildCount()).toBe(0);
  });

  it('changing an argument requires a new approval', async () => {
    const event = makeEvent();
    await handlerFor('mcp:connect')(event, stdioPayload('s-args'));
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    await handlerFor('mcp:disconnect')(event, { connectionId: 's-args' });

    mockShowMessageBox.mockResolvedValue({ response: CANCEL, checkboxChecked: false });
    const res = await handlerFor('mcp:connect')(
      event,
      stdioPayload('s-args', { args: [FIXTURE, '--extra'] })
    );
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
    expect(res.success).toBe(false);
  });

  it('rejects a payload that tries to carry its own approval', async () => {
    const event = makeEvent();
    await expect(
      handlerFor('mcp:connect')(event, stdioPayload('s-pre', { approved: true }))
    ).rejects.toThrow(/Invalid IPC payload/);
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    expect(liveStdioChildCount()).toBe(0);
  });

  it('gives the child only the allowlisted env plus user variables', async () => {
    process.env.RESTURA_PARENT_ONLY_SECRET = 'do-not-leak';
    try {
      const event = makeEvent();
      const res = await handlerFor('mcp:connect')(
        event,
        stdioPayload('s-env', { env: { MY_SETTING: 'on' } })
      );
      expect(res).toEqual({ success: true });
      const keys = (await callText(event, 's-env', 'env-keys')).split(',');
      expect(keys).toContain('MY_SETTING');
      expect(keys).toContain('PATH');
      expect(keys).not.toContain('RESTURA_PARENT_ONLY_SECRET');
      expect(keys).not.toContain('NODE_OPTIONS');
      expect(keys).not.toContain('ELECTRON_RUN_AS_NODE');
    } finally {
      delete process.env.RESTURA_PARENT_ONLY_SECRET;
    }
  });

  it('kills the child when the owning renderer is destroyed', async () => {
    const event = makeEvent();
    expect(await handlerFor('mcp:connect')(event, stdioPayload('s-dead'))).toEqual({
      success: true,
    });
    const pid = Number(await callText(event, 's-dead', 'pid'));
    event.sender.emit('destroyed');
    expect(await waitUntilGone(pid)).toBe(true);
  });

  it('kills every child on module dispose (app quit)', async () => {
    const a = makeEvent();
    const b = makeEvent();
    await handlerFor('mcp:connect')(a, stdioPayload('q-1'));
    await handlerFor('mcp:connect')(b, stdioPayload('q-2'));
    const pids = [Number(await callText(a, 'q-1', 'pid')), Number(await callText(b, 'q-2', 'pid'))];
    expect(liveStdioChildCount()).toBe(2);
    await stopMcpCleanup();
    for (const pid of pids) expect(await waitUntilGone(pid)).toBe(true);
    expect(liveStdioChildCount()).toBe(0);
  });

  it('reports spawn failures with the stderr tail and leaves nothing running', async () => {
    const event = makeEvent();
    const res = await handlerFor('mcp:connect')(event, {
      connectionId: 's-fail',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("boom: missing config\\n"); process.exit(3)'],
    });
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('boom: missing config');
    expect(liveStdioChildCount()).toBe(0);
  });

  it('fails cleanly when the command does not exist', async () => {
    const event = makeEvent();
    const res = await handlerFor('mcp:connect')(event, {
      connectionId: 's-enoent',
      transport: 'stdio',
      command: path.join(tmp, 'definitely-not-a-binary'),
    });
    expect(res.success).toBe(false);
    expect(liveStdioChildCount()).toBe(0);
  });

  it('refuses a working directory that does not exist before prompting', async () => {
    const event = makeEvent();
    const res = await handlerFor('mcp:connect')(
      event,
      stdioPayload('s-cwd', { cwd: path.join(tmp, 'missing') })
    );
    expect(res).toEqual({ success: false, error: expect.stringMatching(/Working directory/) });
    expect(mockShowMessageBox).not.toHaveBeenCalled();
  });

  it('revoke clears persisted approvals so the next launch prompts again', async () => {
    const event = makeEvent();
    await handlerFor('mcp:connect')(event, stdioPayload('s-rev'));
    await handlerFor('mcp:disconnect')(event, { connectionId: 's-rev' });
    expect(await handlerFor('mcp:stdio:revoke-approvals')(event)).toEqual({
      success: true,
      revoked: 1,
    });
    await handlerFor('mcp:connect')(event, stdioPayload('s-rev'));
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
  });

  it('records the spawned pid in the marker (sanity for the denial test)', async () => {
    const marker = path.join(tmp, 'spawned.txt');
    const event = makeEvent();
    await handlerFor('mcp:connect')(
      event,
      stdioPayload('s-mark', { env: { MCP_STDIO_FIXTURE_MARKER: marker } })
    );
    const pid = Number(await callText(event, 's-mark', 'pid'));
    expect(readFileSync(marker, 'utf8').trim()).toBe(String(pid));
  });
});
