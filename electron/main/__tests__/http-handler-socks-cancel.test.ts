// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createConnection = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));
vi.mock('net', () => ({ createConnection, isIP: vi.fn(() => 0) }));

import { openSocksSocket } from '../handlers/http-handler';

class FakeSocket extends EventEmitter {
  destroyed = false;
  write = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
}

describe('openSocksSocket cancellation', () => {
  beforeEach(() => createConnection.mockReset());

  it('destroys the socket, removes listeners, and settles while connection setup is queued', async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValue(socket);
    const controller = new AbortController();
    const pending = openSocksSocket(
      {
        enabled: true,
        type: 'socks5',
        host: 'proxy.example',
        port: 1080,
      },
      'target.example',
      443,
      controller.signal
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('data')).toBe(0);
    expect(socket.listenerCount('error')).toBe(0);
  });

  it('preserves a successful SOCKS5 handshake', async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValue(socket);
    const pending = openSocksSocket(
      {
        enabled: true,
        type: 'socks5',
        host: 'proxy.example',
        port: 1080,
      },
      'target.example',
      443
    );

    socket.emit('connect');
    expect(socket.write).toHaveBeenCalledWith(Buffer.from([0x05, 0x01, 0x00]));
    socket.emit('data', Buffer.from([0x05, 0x00]));
    expect(socket.write).toHaveBeenCalledTimes(2);
    socket.emit('data', Buffer.from([0x05, 0x00]));

    await expect(pending).resolves.toBe(socket);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(socket.listenerCount('error')).toBe(0);
  });
});
