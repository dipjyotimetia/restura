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
  __setStdioConsentMacKeyProviderForTests,
  __setStdioConsentStoreForTests,
  type ConsentStoreShape,
} from '../security/mcp-stdio-consent';
import { __setSecretStoreForTests, type SecretStoreShape } from '../security/secret-handle-store';

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
    __setStdioConsentMacKeyProviderForTests(() => Buffer.alloc(32, 7));
    mockShowMessageBox.mockResolvedValue({ response: ALWAYS, checkboxChecked: false });
  });

  afterEach(async () => {
    await stopMcpCleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  afterAll(() => {
    __setStdioConsentStoreForTests(null);
    __setStdioConsentMacKeyProviderForTests(null);
    __setSecretStoreForTests(null);
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

  it('kills the child when the renderer reloads, but not on hash-router navigation', async () => {
    const event = makeEvent();
    expect(await handlerFor('mcp:connect')(event, stdioPayload('s-reload'))).toEqual({
      success: true,
    });
    const pid = Number(await callText(event, 's-reload', 'pid'));
    // createHashRouter: same-document navigations keep the page (and its sessions).
    event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    event.sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(await callText(event, 's-reload', 'pid')).toBe(String(pid));
    expect(liveStdioChildCount()).toBe(1);

    // View → Reload keeps the webContents but replaces the document.
    event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(await waitUntilGone(pid)).toBe(true);
    await vi.waitFor(() => expect(liveStdioChildCount()).toBe(0));
    const after = await handlerFor('mcp:request')(event, {
      connectionId: 's-reload',
      method: 'tools/list',
    });
    expect(after).toEqual({ success: false, error: 'Not connected' });

    // The reloaded page can connect again, and a second reload cleans up again.
    expect(await handlerFor('mcp:connect')(event, stdioPayload('s-reload'))).toEqual({
      success: true,
    });
    const pid2 = Number(await callText(event, 's-reload', 'pid'));
    event.sender.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(await waitUntilGone(pid2)).toBe(true);
  });

  it('wires the server→client bridge: roots/elicitation/sampling advertised, roots served, disposed on disconnect', async () => {
    const event = makeEvent();
    const roots = [{ uri: 'file:///tmp/project', name: 'project' }];
    expect(
      await handlerFor('mcp:set-roots')(event, { connectionId: 's-roots', roots })
    ).toMatchObject({ success: true, notified: 0 });
    expect(await handlerFor('mcp:connect')(event, stdioPayload('s-roots'))).toEqual({
      success: true,
    });
    const caps = JSON.parse(await callText(event, 's-roots', 'client-caps')) as Record<
      string,
      unknown
    >;
    expect(caps).toMatchObject({
      elicitation: { form: {} },
      sampling: {},
      roots: { listChanged: true },
    });
    expect(await callText(event, 's-roots', 'roots')).toBe('file:///tmp/project');
    // A live session gets roots list_changed.
    expect(
      await handlerFor('mcp:set-roots')(event, { connectionId: 's-roots', roots: [] })
    ).toMatchObject({ success: true, notified: 1 });

    await handlerFor('mcp:disconnect')(event, { connectionId: 's-roots' });
    // Disposed bridge: nothing left to notify.
    expect(
      await handlerFor('mcp:set-roots')(event, { connectionId: 's-roots', roots })
    ).toMatchObject({ success: true, notified: 0 });
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
    expect(res).toEqual({ success: false, error: expect.stringMatching(/not found/) });
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    expect(liveStdioChildCount()).toBe(0);
  });

  it('does not touch the working directory before consent; a missing one fails after it', async () => {
    const event = makeEvent();
    mockShowMessageBox.mockResolvedValue({ response: CANCEL, checkboxChecked: false });
    const denied = await handlerFor('mcp:connect')(
      event,
      stdioPayload('s-cwd', { cwd: path.join(tmp, 'missing') })
    );
    expect(denied.error).toMatch(/not approved/);
    mockShowMessageBox.mockResolvedValue({ response: ALWAYS, checkboxChecked: false });
    const res = await handlerFor('mcp:connect')(
      event,
      stdioPayload('s-cwd', { cwd: path.join(tmp, 'missing') })
    );
    expect(res).toEqual({ success: false, error: expect.stringMatching(/Working directory/) });
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
  });

  it('resolves a bare command on PATH (never the cwd) and spawns the resolved file', async () => {
    const event = makeEvent();
    const res = await handlerFor('mcp:connect')(event, {
      ...stdioPayload('s-bare'),
      command: 'node',
      env: { PATH: path.dirname(process.execPath) },
    });
    expect(res).toEqual({ success: true });
    const options = mockShowMessageBox.mock.calls[0]!.at(-1) as { detail: string };
    expect(options.detail).toContain(
      `Program: ${JSON.stringify(path.join(path.dirname(process.execPath), 'node'))}`
    );
    expect(options.detail).toContain('(requested as "node")');
  });

  it('refuses an unknown secret handle before prompting, and uses a known one', async () => {
    const records: Record<string, { value: string; createdAt: number; label?: string }> = {
      'h-known': { value: 'tok-123', createdAt: 1, label: 'Real label' },
    };
    const secretStore: SecretStoreShape = {
      get: (k) => records[k],
      set: (k, v) => {
        records[k] = v;
      },
      delete: (k) => {
        delete records[k];
      },
      clear: () => {},
      has: (k) => k in records,
      store: records,
    };
    __setSecretStoreForTests(secretStore);
    const event = makeEvent();
    const missing = await handlerFor('mcp:connect')(
      event,
      stdioPayload('s-h1', { env: { API_TOKEN: { kind: 'handle', id: 'h-unknown' } } })
    );
    expect(missing).toEqual({ success: false, error: expect.stringMatching(/not found/) });
    expect(mockShowMessageBox).not.toHaveBeenCalled();

    const ok = await handlerFor('mcp:connect')(
      event,
      stdioPayload('s-h2', {
        env: { API_TOKEN: { kind: 'handle', id: 'h-known', label: 'spoofed label' } },
      })
    );
    expect(ok).toEqual({ success: true });
    const detail = (mockShowMessageBox.mock.calls[0]!.at(-1) as { detail: string }).detail;
    expect(detail).toContain('"Real label"');
    expect(detail).not.toContain('spoofed label');
    expect(detail).not.toContain('tok-123');
    expect((await callText(event, 's-h2', 'env-keys')).split(',')).toContain('API_TOKEN');

    // Rotating the secret behind the handle re-prompts.
    await handlerFor('mcp:disconnect')(event, { connectionId: 's-h2' });
    records['h-known'] = { ...records['h-known']!, value: 'tok-456' };
    await handlerFor('mcp:connect')(
      event,
      stdioPayload('s-h2', { env: { API_TOKEN: { kind: 'handle', id: 'h-known' } } })
    );
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
  });

  it('caps running stdio servers even when connects race their consent dialogs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mockShowMessageBox.mockImplementation(async () => {
      await gate;
      return { response: 1, checkboxChecked: false };
    });
    const events = Array.from({ length: 10 }, () => makeEvent());
    const pending = events.map((event, i) =>
      handlerFor('mcp:connect')(event, stdioPayload(`cap-${i}`))
    );
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = await Promise.all(pending);
    const ok = results.filter((r) => r.success).length;
    expect(ok).toBe(8);
    expect(results.filter((r) => String(r.error).includes('Too many')).length).toBe(2);
    expect(liveStdioChildCount()).toBe(8);
  });

  it('revoke clears persisted approvals so the next launch prompts again', async () => {
    const event = makeEvent();
    await handlerFor('mcp:connect')(event, stdioPayload('s-rev'));
    await handlerFor('mcp:disconnect')(event, { connectionId: 's-rev' });
    await expect(handlerFor('mcp:stdio:revoke-approvals')(event, { all: true })).rejects.toThrow(
      /Invalid IPC payload/
    );
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
