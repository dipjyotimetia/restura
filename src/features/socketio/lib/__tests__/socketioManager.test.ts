import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

// Fake browser socket.io-client: records options + listeners so tests can feed
// onAny deliveries (including a trailing server-ack callback).
const sio = vi.hoisted(() => {
  class FakeSocket {
    static last: FakeSocket | undefined;
    connected = true;
    id = 'sock-1';
    url: string;
    opts: Record<string, unknown>;
    anyListeners: Listener[] = [];
    emitted: Array<{ flags: string[]; args: unknown[] }> = [];
    private flags: string[] = [];
    listeners = new Map<string, Listener>();
    managerListeners = new Map<string, Listener>();
    io = {
      on: (evt: string, cb: Listener) => {
        this.managerListeners.set(evt, cb);
        return this.io;
      },
    };
    constructor(url: string, opts: Record<string, unknown>) {
      this.url = url;
      this.opts = opts;
      FakeSocket.last = this;
    }
    on(evt: string, cb: Listener) {
      this.listeners.set(evt, cb);
      return this;
    }
    onAny(cb: Listener) {
      this.anyListeners.push(cb);
      return this;
    }
    get volatile() {
      this.flags.push('volatile');
      return this;
    }
    compress(v: boolean) {
      this.flags.push(`compress:${v}`);
      return this;
    }
    emit(...args: unknown[]) {
      this.emitted.push({ flags: this.flags, args });
      this.flags = [];
      return this;
    }
    removeAllListeners() {
      return this;
    }
    disconnect() {
      this.connected = false;
      return this;
    }
    fireAny(eventName: string, ...args: unknown[]) {
      for (const cb of this.anyListeners) cb(eventName, ...args);
    }
  }
  return {
    FakeSocket,
    io: (url: string, opts: Record<string, unknown>) => new FakeSocket(url, opts),
  };
});

vi.mock('socket.io-client', () => ({ io: sio.io }));

import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import type { StreamingVariableScope } from '@/lib/shared/streaming/messageVariables';
import { connectWithVariables } from '../connectWithVariables';
import { socketioManager } from '../socketioManager';

const scope: StreamingVariableScope = {
  values: { base: 'https://sio.example.com', secret: 's3cr3t', uid: '42' },
  secretNames: new Set(['secret']),
  handleNames: new Set(),
};

describe('socketioManager (browser)', () => {
  let id: string;
  const conn = () => useSocketIOStore.getState().connections[id]!;
  const socket = () => sio.FakeSocket.last!;

  beforeEach(() => {
    id = useSocketIOStore.getState().createConnection('{{base}}?token={{secret}}');
  });

  afterEach(() => {
    socketioManager.disconnect(id);
    useSocketIOStore.getState().removeConnection(id);
    sio.FakeSocket.last = undefined;
  });

  it('connects to the resolved URL without writing it back to the store (SIO-2)', () => {
    expect(connectWithVariables(id, scope)).toEqual({ ok: true });
    expect(socket().url).toBe('https://sio.example.com?token=s3cr3t');
    expect(conn().url).toBe('{{base}}?token={{secret}}');
  });

  it('passes reconnection tuning through to the client', () => {
    useSocketIOStore.getState().updateConnectionField(id, 'reconnectionDelayMax', 9_000);
    useSocketIOStore.getState().updateConnectionField(id, 'randomizationFactor', 0.2);
    connectWithVariables(id, scope);
    expect(socket().opts).toMatchObject({ reconnectionDelayMax: 9_000, randomizationFactor: 0.2 });
  });

  it('sends nested JSON auth with {{var}} resolution (SIO-4)', () => {
    const s = useSocketIOStore.getState();
    s.updateConnectionField(id, 'authMode', 'json');
    s.updateConnectionField(
      id,
      'authJson',
      '{"token":"{{secret}}","user":{"id":{{uid}},"admin":true}}'
    );
    connectWithVariables(id, scope);
    expect(socket().opts.auth).toEqual({ token: 's3cr3t', user: { id: 42, admin: true } });
    expect(conn().authJson).toContain('{{secret}}');
  });

  it('blocks connect on invalid auth JSON without leaking secrets', () => {
    const s = useSocketIOStore.getState();
    s.updateConnectionField(id, 'authMode', 'json');
    s.updateConnectionField(id, 'authJson', '{"t": {{secret}} ');
    const out = connectWithVariables(id, scope);
    expect(out.ok).toBe(false);
    expect(sio.FakeSocket.last).toBeUndefined();
    expect(JSON.stringify(conn().events)).not.toContain('s3cr3t');
    expect(conn().status).toBe('disconnected');
  });

  it('rejects a non-object auth payload', () => {
    const s = useSocketIOStore.getState();
    s.updateConnectionField(id, 'authMode', 'json');
    s.updateConnectionField(id, 'authJson', '[1,2]');
    expect(connectWithVariables(id, scope).ok).toBe(false);
  });

  it('surfaces server-requested acks and answers them (SIO-1)', () => {
    connectWithVariables(id, scope);
    const ack = vi.fn();
    socket().fireAny('question', { q: 1 }, ack);
    const row = conn().events.find((e) => e.eventName === 'question')!;
    expect(row.args).toEqual([{ q: 1 }]);
    expect(row.serverAckId).toBeTruthy();
    expect(JSON.stringify(conn().events)).not.toContain('function');

    socketioManager.replyServerAck(id, row.serverAckId!, ['yes', 2]);
    expect(ack).toHaveBeenCalledWith('yes', 2);
    expect(conn().events.find((e) => e.id === row.id)?.serverAckReplied).toBe(true);
    expect(conn().events.at(-1)).toMatchObject({ direction: 'sent', eventName: '<ack reply>' });

    // A second reply is refused — the callback is single-use.
    socketioManager.replyServerAck(id, row.serverAckId!, ['again']);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(conn().events.at(-1)?.args[0]).toMatch(/already answered/);
  });

  it('logs application events named reconnect* (SIO-6)', () => {
    connectWithVariables(id, scope);
    socket().fireAny('reconnect', 'app-level');
    socket().fireAny('reconnect_attempt', 3);
    const names = conn()
      .events.filter((e) => e.direction === 'received')
      .map((e) => e.eventName);
    expect(names).toEqual(['reconnect', 'reconnect_attempt']);
  });

  it('applies volatile / compress modifiers and logs binary as $binary (SIO-5)', () => {
    connectWithVariables(id, scope);
    socketioManager.emit(id, 'bin', [new Uint8Array([1, 2, 3])], false, undefined, {
      volatile: true,
      compress: false,
    });
    expect(socket().emitted.at(-1)?.flags).toEqual(['volatile', 'compress:false']);
    expect(conn().events.at(-1)?.args).toEqual([{ $binary: 'AQID' }]);
  });

  it('honours a configurable ack timeout', () => {
    vi.useFakeTimers();
    try {
      connectWithVariables(id, scope);
      socketioManager.emit(id, 'slow', [], true, undefined, { ackTimeoutMs: 500 });
      vi.advanceTimersByTime(499);
      expect(conn().events.some((e) => e.ackStatus === 'timeout')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(conn().events.some((e) => e.ackStatus === 'timeout')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a desktop ack reply once even when clicked twice while in flight', async () => {
    const platform = await import('@/lib/shared/platform');
    let resolveReply!: (v: { success: boolean }) => void;
    const replyAck = vi.fn(
      () =>
        new Promise<{ success: boolean }>((r) => {
          resolveReply = r;
        })
    );
    const spy = vi
      .spyOn(platform, 'getElectronAPI')
      .mockReturnValue({ socketio: { replyAck } } as never);
    const electron = (socketioManager as unknown as { electronConnections: Set<string> })
      .electronConnections;
    electron.add(id);
    try {
      socketioManager.replyServerAck(id, 'srv-1', ['a']);
      socketioManager.replyServerAck(id, 'srv-1', ['a']);
      expect(replyAck).toHaveBeenCalledTimes(1);
      resolveReply({ success: true });
      await vi.waitFor(() =>
        expect(conn().events.at(-1)).toMatchObject({ eventName: '<ack reply>' })
      );
      expect(conn().events.filter((e) => /Ack reply failed/.test(String(e.args[0])))).toEqual([]);
    } finally {
      electron.delete(id);
      spy.mockRestore();
    }
  });

  it('maps browser socket + manager lifecycle events onto store state', () => {
    connectWithVariables(id, scope);
    const sock = socket();
    sock.listeners.get('connect')?.();
    expect(conn().status).toBe('connected');
    expect(socketioManager.isConnected(id)).toBe(true);
    sock.listeners.get('connect_error')?.(new Error('nope'));
    expect(conn().events.at(-1)).toMatchObject({ eventName: 'connect_error', args: ['nope'] });
    sock.managerListeners.get('reconnect_attempt')?.(2);
    expect(conn().status).toBe('reconnecting');
    expect(conn().reconnectAttemptCount).toBe(2);
    sock.managerListeners.get('reconnect')?.(2);
    expect(conn().events.at(-1)).toMatchObject({ eventName: 'reconnect', args: [{ attempt: 2 }] });
    sock.managerListeners.get('reconnect_failed')?.();
    expect(conn().events.at(-1)).toMatchObject({ eventName: 'reconnect_failed' });
    sock.listeners.get('disconnect')?.('transport close');
    expect(conn().status).toBe('disconnected');
    expect(conn().events.at(-1)).toMatchObject({ eventName: 'disconnect' });
  });

  it('warns that extraHeaders are dropped on the browser websocket transport', () => {
    useSocketIOStore
      .getState()
      .setKv(id, 'extraHeaders', [{ id: 'h', key: 'x-a', value: '1', enabled: true }]);
    connectWithVariables(id, scope);
    expect(conn().events.some((e) => /Custom headers are ignored/.test(String(e.args[0])))).toBe(
      true
    );
  });

  it('refuses to emit while disconnected and resolves acks in time', () => {
    socketioManager.emit(id, 'x', []);
    expect(conn().events.at(-1)?.args[0]).toBe('Cannot emit: socket is not connected');

    connectWithVariables(id, scope);
    socketioManager.emit(id, 'q', ['a'], true);
    const call = socket().emitted.at(-1)!;
    const cb = call.args.at(-1) as (...a: unknown[]) => void;
    cb('pong', new Uint8Array([1]));
    expect(conn().events.at(-1)).toMatchObject({
      direction: 'ack',
      ackStatus: 'ok',
      args: ['pong', { $binary: 'AQ==' }],
    });
    cb('late'); // already resolved — ignored
    expect(conn().events.filter((e) => e.direction === 'ack')).toHaveLength(1);
  });

  it('reports a server ack reply whose callback throws', () => {
    connectWithVariables(id, scope);
    socket().fireAny('q', () => {
      throw new Error('socket closed');
    });
    const row = conn().events.find((e) => e.eventName === 'q')!;
    expect(socketioManager.canReplyServerAck(id, row.serverAckId!)).toBe(true);
    socketioManager.replyServerAck(id, row.serverAckId!, []);
    expect(conn().events.at(-1)?.args[0]).toBe('Ack reply failed: socket closed');
  });

  it('cleanup disconnects every browser socket', () => {
    connectWithVariables(id, scope);
    socketioManager.cleanup();
    expect(socket().connected).toBe(false);
    expect(conn().status).toBe('disconnected');
  });
});
