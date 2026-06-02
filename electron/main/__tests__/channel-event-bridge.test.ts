// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { EventEmitter as EventEmitterType } from 'node:events';

// Back the mocked ipcRenderer with a real EventEmitter so on/removeListener/emit
// behave exactly like Electron's (identity-based removal) — that's the property
// the bridge's wrapper registry has to get right.
const { ee } = vi.hoisted(() => {
  const { EventEmitter } = require('node:events');
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return { ee: emitter as EventEmitterType };
});

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...a: unknown[]) => void) => ee.on(channel, listener),
    removeListener: (channel: string, listener: (...a: unknown[]) => void) =>
      ee.removeListener(channel, listener),
    removeAllListeners: (channel: string) => ee.removeAllListeners(channel),
  },
}));

import { channelEventBridge } from '../channel-event-bridge';

const grpc = channelEventBridge('grpc:');

describe('channelEventBridge', () => {
  it('delivers events to a subscribed callback', () => {
    const ch = 'grpc:data:deliver';
    const cb = vi.fn();
    grpc.on(ch, cb);
    ee.emit(ch, {}, { n: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ n: 1 });
  });

  it('removeListener actually removes — the wrapper is found and detached', () => {
    const ch = 'grpc:data:remove';
    const cb = vi.fn();
    grpc.on(ch, cb);
    grpc.removeListener(ch, cb);
    ee.emit(ch, {}, { n: 1 });
    expect(cb).not.toHaveBeenCalled();
    expect(ee.listenerCount(ch)).toBe(0);
  });

  it('does not stack duplicate listeners across re-subscribe (the gRPC re-run case)', () => {
    // Same stable channel (mirrors a per-tab request.id) used across two runs.
    const ch = 'grpc:data:rerun';
    const cb1 = vi.fn();
    grpc.on(ch, cb1);
    grpc.removeListener(ch, cb1);

    const cb2 = vi.fn();
    grpc.on(ch, cb2);
    ee.emit(ch, {}, 'x');

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1); // fires once, not N times
    expect(ee.listenerCount(ch)).toBe(1);
  });

  it('re-subscribing the same callback on the same channel is a no-op', () => {
    const ch = 'grpc:data:dedupe';
    const cb = vi.fn();
    grpc.on(ch, cb);
    grpc.on(ch, cb);
    expect(ee.listenerCount(ch)).toBe(1);
    ee.emit(ch, {}, 'y');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('ignores channels outside the prefix allowlist', () => {
    const cb = vi.fn();
    grpc.on('ws:message:1', cb);
    expect(ee.listenerCount('ws:message:1')).toBe(0);
    grpc.removeListener('ws:message:1', cb); // also a no-op, must not throw
  });

  it('removeAllListeners detaches everything on the channel', () => {
    const ch = 'grpc:data:all';
    grpc.on(ch, vi.fn());
    grpc.on(ch, vi.fn());
    grpc.removeAllListeners(ch);
    expect(ee.listenerCount(ch)).toBe(0);
  });

  it('keeps separate protocol prefixes independent', () => {
    const ws = channelEventBridge('ws:');
    const wsCb = vi.fn();
    ws.on('ws:message:7', wsCb);
    ee.emit('ws:message:7', {}, 'hi');
    expect(wsCb).toHaveBeenCalledWith('hi');
    ws.removeListener('ws:message:7', wsCb);
    ee.emit('ws:message:7', {}, 'bye');
    expect(wsCb).toHaveBeenCalledTimes(1);
  });
});
