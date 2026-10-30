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
    io = { on: () => this.io };
    constructor(url: string, opts: Record<string, unknown>) {
      this.url = url;
      this.opts = opts;
      FakeSocket.last = this;
    }
    on() {
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
});
