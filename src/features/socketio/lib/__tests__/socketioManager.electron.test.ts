import { socketioChannels } from '@shared/socketio-constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (payload?: unknown) => void;

// Fake `window.electron.socketio`: records channel listeners so tests can play
// the main process's emissions back into the renderer manager.
const api = vi.hoisted(() => {
  const listeners = new Map<string, Listener>();
  const socketio = {
    connect: vi.fn(
      async (_cfg: unknown) => ({ success: true }) as { success: boolean; error?: string }
    ),
    emit: vi.fn(async (_cfg: unknown) => ({ success: true })),
    replyAck: vi.fn(
      async (_cfg: unknown) => ({ success: true }) as { success: boolean; error?: string }
    ),
    disconnect: vi.fn(async (_cfg: unknown) => ({ success: true })),
    on: vi.fn((ch: string, cb: Listener) => {
      listeners.set(ch, cb);
    }),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn((ch: string) => {
      listeners.delete(ch);
    }),
  };
  return { listeners, socketio, present: { value: true } };
});

vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => true,
  getElectronAPI: () => (api.present.value ? { socketio: api.socketio } : null),
}));

import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { socketioManager } from '../socketioManager';

const fire = (channel: string, payload?: unknown) => {
  const cb = api.listeners.get(channel);
  if (!cb) throw new Error(`no listener on ${channel}`);
  cb(payload);
};

describe('socketioManager (desktop IPC path)', () => {
  let id: string;
  const conn = () => useSocketIOStore.getState().connections[id]!;
  const lastEvent = () => conn().events.at(-1);

  beforeEach(() => {
    api.present.value = true;
    api.listeners.clear();
    for (const fn of Object.values(api.socketio)) fn.mockClear();
    id = useSocketIOStore.getState().createConnection('https://sio.example.com');
  });

  afterEach(() => {
    socketioManager.disconnect(id);
    useSocketIOStore.getState().removeConnection(id);
  });

  it('forwards the full connection config over IPC', () => {
    const s = useSocketIOStore.getState();
    s.updateConnectionField(id, 'namespace', '/chat');
    s.updateConnectionField(id, 'reconnectionDelayMax', 7_000);
    s.setKv(id, 'auth', [{ id: 'a', key: 'token', value: 't', enabled: true }]);
    socketioManager.connect(id);
    expect(api.socketio.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: id,
        url: 'https://sio.example.com',
        namespace: '/chat',
        auth: { token: 't' },
        reconnectionDelayMax: 7_000,
        randomizationFactor: 0.5,
      })
    );
    expect(conn().status).toBe('connecting');
  });

  it('maps every main-process channel onto store state', () => {
    socketioManager.connect(id);

    fire(socketioChannels.open(id), { socketId: 'sock-9' });
    expect(conn().status).toBe('connected');
    expect(lastEvent()).toMatchObject({ eventName: 'connect', args: [{ socketId: 'sock-9' }] });
    expect(socketioManager.isConnected(id)).toBe(true);

    fire(socketioChannels.event(id), { eventName: 'news', args: [1], serverAckId: 'srv-1' });
    expect(lastEvent()).toMatchObject({
      direction: 'received',
      eventName: 'news',
      args: [1],
      serverAckId: 'srv-1',
    });
    fire(socketioChannels.event(id), { eventName: 'bare' });
    expect(lastEvent()).toMatchObject({ eventName: 'bare', args: [] });
    expect(lastEvent()?.serverAckId).toBeUndefined();
    const before = conn().events.length;
    fire(socketioChannels.event(id), {});
    expect(conn().events.length).toBe(before);

    fire(socketioChannels.error(id), { message: 'boom' });
    expect(lastEvent()).toMatchObject({ eventName: 'connect_error', args: ['boom'] });
    fire(socketioChannels.error(id));
    expect(lastEvent()?.args).toEqual(['unknown error']);

    fire(socketioChannels.reconnectAttempt(id), { attempt: 3 });
    expect(conn().status).toBe('reconnecting');
    expect(conn().reconnectAttemptCount).toBe(3);
    fire(socketioChannels.reconnectAttempt(id));
    expect(lastEvent()).toMatchObject({ eventName: 'reconnect_attempt' });

    fire(socketioChannels.reconnect(id), { attempt: 3 });
    expect(lastEvent()).toMatchObject({ eventName: 'reconnect', args: [{ attempt: 3 }] });
    fire(socketioChannels.reconnect(id));
    expect(lastEvent()?.args).toEqual([{}]);

    fire(socketioChannels.reconnectFailed(id));
    expect(lastEvent()).toMatchObject({ eventName: 'reconnect_failed' });

    fire(socketioChannels.close(id), { reason: 'io server disconnect' });
    expect(conn().status).toBe('disconnected');
    expect(lastEvent()).toMatchObject({ eventName: 'disconnect', args: ['io server disconnect'] });
    fire(socketioChannels.close(id));
    expect(lastEvent()?.args).toEqual(['unknown']);
  });

  it('resolves outbound acks, including timeouts, from the ack channel', () => {
    socketioManager.connect(id);
    socketioManager.emit(id, 'q', ['x'], true, undefined, {
      ackTimeoutMs: 3_000,
      volatile: true,
      compress: false,
    });
    const cfg = api.socketio.emit.mock.calls[0]?.[0] as { ackId: string };
    expect(cfg).toMatchObject({
      eventName: 'q',
      args: ['x'],
      ackTimeoutMs: 3_000,
      volatile: true,
      compress: false,
    });

    fire(socketioChannels.ack(id), { ackId: cfg.ackId, args: ['ok'] });
    expect(lastEvent()).toMatchObject({ direction: 'ack', ackStatus: 'ok', args: ['ok'] });
    fire(socketioChannels.ack(id), { ackId: cfg.ackId, error: 'timeout' });
    expect(lastEvent()).toMatchObject({ ackStatus: 'timeout', args: [] });
    const count = conn().events.length;
    fire(socketioChannels.ack(id), {});
    expect(conn().events.length).toBe(count);
  });

  it('emits without ack or modifiers sends a bare IPC payload', () => {
    socketioManager.connect(id);
    socketioManager.emit(id, 'plain', [1]);
    expect(api.socketio.emit).toHaveBeenCalledWith({
      connectionId: id,
      eventName: 'plain',
      args: [1],
    });
    expect(lastEvent()).toMatchObject({ direction: 'sent', eventName: 'plain' });
  });

  it('reports a rejected or failed connect and drops the IPC listeners', async () => {
    api.socketio.connect.mockResolvedValueOnce({ success: false, error: 'denied by policy' });
    socketioManager.connect(id);
    await vi.waitFor(() =>
      expect(lastEvent()?.args[0]).toBe('Failed to connect: denied by policy')
    );
    expect(conn().status).toBe('disconnected');
    expect(api.listeners.size).toBe(0);

    api.socketio.connect.mockRejectedValueOnce(new Error('ipc down'));
    socketioManager.connect(id);
    await vi.waitFor(() => expect(lastEvent()?.args[0]).toBe('Failed to connect: ipc down'));

    api.socketio.connect.mockRejectedValueOnce('weird');
    socketioManager.connect(id);
    await vi.waitFor(() =>
      expect(lastEvent()?.args[0]).toBe('Failed to connect: Connection failed')
    );
  });

  it('logs a failed or rejected ack reply', async () => {
    socketioManager.connect(id);
    api.socketio.replyAck.mockResolvedValueOnce({ success: false, error: 'expired' });
    socketioManager.replyServerAck(id, 'srv-1', ['a']);
    await vi.waitFor(() => expect(lastEvent()?.args[0]).toBe('Ack reply failed: expired'));

    api.socketio.replyAck.mockRejectedValueOnce(new Error('ipc gone'));
    socketioManager.replyServerAck(id, 'srv-2', ['a']);
    await vi.waitFor(() => expect(lastEvent()?.args[0]).toBe('Ack reply failed: ipc gone'));

    api.socketio.replyAck.mockResolvedValueOnce({ success: true });
    socketioManager.replyServerAck(id, 'srv-3', ['secret'], { args: ['••••••'] });
    await vi.waitFor(() =>
      expect(lastEvent()).toMatchObject({ eventName: '<ack reply>', args: ['••••••'] })
    );
    expect(socketioManager.canReplyServerAck(id, 'srv-3')).toBe(false);
  });

  it('disconnects over IPC and clears listeners', () => {
    socketioManager.connect(id);
    socketioManager.disconnect(id);
    expect(api.socketio.disconnect).toHaveBeenCalledWith({ connectionId: id });
    expect(api.listeners.size).toBe(0);
    expect(conn().status).toBe('disconnected');
  });

  it('fails cleanly when the Electron API is unavailable', () => {
    api.present.value = false;
    socketioManager.connect(id);
    expect(lastEvent()?.args[0]).toBe('Electron Socket.IO API is unavailable.');
    expect(conn().status).toBe('disconnected');
  });

  it('rejects an invalid URL before touching IPC', () => {
    useSocketIOStore.getState().updateConnectionField(id, 'url', 'ftp://nope');
    socketioManager.connect(id);
    expect(api.socketio.connect).not.toHaveBeenCalled();
    expect(String(lastEvent()?.args[0])).toMatch(/^Connection failed: Invalid protocol/);
  });

  it('blocks connect on invalid stored auth JSON', () => {
    const s = useSocketIOStore.getState();
    s.updateConnectionField(id, 'authMode', 'json');
    s.updateConnectionField(id, 'authJson', '{oops');
    socketioManager.connect(id);
    expect(api.socketio.connect).not.toHaveBeenCalled();
    expect(String(lastEvent()?.args[0])).toMatch(/^Connection failed: Invalid auth JSON/);

    s.updateConnectionField(id, 'authJson', '  ');
    socketioManager.connect(id);
    expect(api.socketio.connect).toHaveBeenLastCalledWith(expect.objectContaining({ auth: {} }));
  });

  it('ignores connect for an unknown connection', () => {
    socketioManager.connect('missing');
    expect(api.socketio.connect).not.toHaveBeenCalled();
  });
});
