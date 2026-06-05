// @vitest-environment node
//
// Behavioural wiring for the WebSocket handler: it adapts the `ws` library to
// the IPC event surface. We mock `ws` and the infra deps (no real socket) and
// assert the adapter translates lifecycle events into the right emitTo calls,
// binds renderer cleanup, and honours the send/disconnect contracts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeWs {
  readyState: number;
  terminate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on(event: string, cb: (...args: unknown[]) => void): FakeWs;
  fire(event: string, ...args: unknown[]): void;
}

// Registry of constructed fake sockets so the test can drive their events.
// FakeWs lives inside vi.hoisted so the (hoisted) vi.mock('ws') factory can see it.
const { sockets, FakeWsCtor } = vi.hoisted(() => {
  const sockets: FakeWs[] = [];
  class FakeWsCtor {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    handlers: Record<string, (...args: unknown[]) => void> = {};
    terminate = vi.fn();
    close = vi.fn();
    send = vi.fn();
    constructor(
      public url: string,
      public protocols: unknown,
      public opts: unknown
    ) {
      sockets.push(this as unknown as FakeWs);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      this.handlers[event] = cb;
      return this;
    }
    fire(event: string, ...args: unknown[]) {
      this.handlers[event]?.(...args);
    }
  }
  return { sockets, FakeWsCtor };
});

vi.mock('ws', () => ({ default: FakeWsCtor }));

const { mockEmitTo, mockBind, mockResolve } = vi.hoisted(() => ({
  mockEmitTo: vi.fn(),
  mockBind: vi.fn(),
  mockResolve: vi.fn(),
}));

import { createElectronMock, trustedEvent, getRegisteredHandler } from './helpers/electron-mock';

vi.mock('electron', () => createElectronMock());
vi.mock('../ipc-utils', () => ({ emitTo: mockEmitTo, errorMessage: (e: unknown) => String(e) }));
vi.mock('../connection-cleanup', () => ({
  bindRendererCleanup: mockBind,
  disposeByOwner: vi.fn(),
}));
vi.mock('../safe-connect', () => ({
  resolveSafeAddress: mockResolve,
  createPinnedLookup: vi.fn(() => vi.fn()),
}));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { registerWebSocketHandlerIPC, stopWebSocketCleanup } from '../websocket-handler';

const SENDER_ID = 1;
type Handler = (e: unknown, p: unknown) => Promise<{ success: boolean; error?: string }>;

function connectHandler(): Handler {
  return getRegisteredHandler(ipcMain, IPC.ws.connect) as Handler;
}

describe('websocket-handler', () => {
  beforeEach(() => {
    sockets.length = 0;
    mockEmitTo.mockClear();
    mockBind.mockClear();
    mockResolve.mockReset();
    mockResolve.mockResolvedValue({
      host: 'example.com',
      ip: '93.184.216.34',
      port: 443,
      family: 4,
    });
    vi.mocked(ipcMain.handle).mockClear();
    registerWebSocketHandlerIPC();
  });

  it('opens a socket and acks success after SSRF resolve', async () => {
    const res = await connectHandler()(trustedEvent(SENDER_ID), {
      connectionId: 'c1',
      url: 'wss://example.com',
    });
    expect(res).toEqual({ success: true });
    expect(mockResolve).toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    expect(mockBind).toHaveBeenCalledTimes(1);
  });

  it('returns failure (no socket) when the URL is rejected by SSRF policy', async () => {
    mockResolve.mockRejectedValue(new Error('URL rejected by SSRF policy'));
    const res = await connectHandler()(trustedEvent(SENDER_ID), {
      connectionId: 'c1',
      url: 'wss://169.254.169.254',
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SSRF/);
    expect(sockets).toHaveLength(0);
  });

  it('emits ws:open / text + binary ws:message / ws:close to the originating renderer', async () => {
    await connectHandler()(trustedEvent(SENDER_ID), {
      connectionId: 'c1',
      url: 'wss://example.com',
    });
    const sock = sockets[0]!;

    sock.fire('open');
    expect(mockEmitTo).toHaveBeenCalledWith(SENDER_ID, 'ws:open:c1');

    sock.fire('message', Buffer.from('hello'), false);
    expect(mockEmitTo).toHaveBeenCalledWith(SENDER_ID, 'ws:message:c1', {
      type: 'text',
      data: 'hello',
    });

    sock.fire('message', Buffer.from([1, 2, 3]), true);
    expect(mockEmitTo).toHaveBeenCalledWith(SENDER_ID, 'ws:message:c1', {
      type: 'binary',
      data: Buffer.from([1, 2, 3]).toString('base64'),
    });

    sock.fire('error', new Error('boom'));
    expect(mockEmitTo).toHaveBeenCalledWith(SENDER_ID, 'ws:error:c1', { message: 'boom' });

    sock.fire('close', 1006, Buffer.from('gone'));
    expect(mockEmitTo).toHaveBeenCalledWith(SENDER_ID, 'ws:close:c1', {
      code: 1006,
      reason: 'gone',
    });
  });

  it('does not emit ws:close after an explicit disconnect', async () => {
    await connectHandler()(trustedEvent(SENDER_ID), {
      connectionId: 'c1',
      url: 'wss://example.com',
    });
    const sock = sockets[0]!;

    const disconnect = getRegisteredHandler(ipcMain, IPC.ws.disconnect) as Handler;
    await disconnect(trustedEvent(SENDER_ID), { connectionId: 'c1' });
    expect(sock.close).toHaveBeenCalledWith(1000, 'Client disconnected');

    mockEmitTo.mockClear();
    sock.fire('close', 1000, Buffer.from('Client disconnected'));
    expect(mockEmitTo).not.toHaveBeenCalledWith(SENDER_ID, 'ws:close:c1', expect.anything());
  });

  it('ws:send writes to an open socket and refuses when not connected', async () => {
    await connectHandler()(trustedEvent(SENDER_ID), {
      connectionId: 'c1',
      url: 'wss://example.com',
    });
    const send = getRegisteredHandler(ipcMain, IPC.ws.send) as Handler;

    const ok = await send(trustedEvent(SENDER_ID), { connectionId: 'c1', message: 'hi' });
    expect(ok).toEqual({ success: true });
    expect(sockets[0]!.send).toHaveBeenCalledWith('hi');

    const missing = await send(trustedEvent(SENDER_ID), { connectionId: 'nope', message: 'x' });
    expect(missing).toEqual({ success: false, error: 'Not connected' });
  });

  it('stopWebSocketCleanup terminates and clears all connections', async () => {
    await connectHandler()(trustedEvent(SENDER_ID), {
      connectionId: 'c1',
      url: 'wss://example.com',
    });
    stopWebSocketCleanup();
    expect(sockets[0]!.terminate).toHaveBeenCalled();
  });
});
