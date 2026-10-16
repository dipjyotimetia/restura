import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import {
  attachControlFrameListeners,
  describeClose,
  recordNegotiation,
  sendElectronPing,
  WEB_PING_UNSUPPORTED,
} from '../wsControlFrames';

let id: string;
const conn = () => useWebSocketStore.getState().connections[id]!;
const last = () => conn().messages.at(-1)?.content;
const flush = () => new Promise((r) => setTimeout(r, 0));

function apiWithPing(ping: () => Promise<{ success: boolean; error?: string }>) {
  return { websocket: { ping: vi.fn(ping) } } as never;
}

beforeEach(() => {
  id = useWebSocketStore.getState().createConnection();
});
afterEach(() => useWebSocketStore.getState().removeConnection(id));

describe('wsControlFrames helpers', () => {
  it('describes a close frame with and without a reason', () => {
    expect(describeClose({ code: 4000 })).toBe('Closing (code: 4000)');
    expect(describeClose({ code: 4000, reason: 'x' })).toBe('Closing (code: 4000, reason: x)');
  });

  it('records an empty negotiation and clears a stale RTT', () => {
    useWebSocketStore.getState().patchControlState(id, { lastPingRttMs: 9 });
    expect(recordNegotiation(id, undefined, undefined)).toBe('');
    expect(conn().negotiated).toEqual({ protocol: '', extensions: '' });
    expect(conn().lastPingRttMs).toBeUndefined();
  });

  it('patchControlState ignores unknown connections', () => {
    const before = useWebSocketStore.getState().connections;
    useWebSocketStore.getState().patchControlState('missing', { perMessageDeflate: false });
    expect(useWebSocketStore.getState().connections).toBe(before);
  });

  it('attachControlFrameListeners is a no-op without the IPC bridge', () => {
    expect(() => attachControlFrameListeners(id, null)).not.toThrow();
  });

  it('refuses to ping without the IPC bridge', () => {
    expect(sendElectronPing(id, '', null)).toBe(false);
    expect(last()).toBe(WEB_PING_UNSUPPORTED);
  });

  it('logs ping failures from a rejected or unsuccessful IPC call', async () => {
    sendElectronPing(
      id,
      '',
      apiWithPing(async () => ({ success: false }))
    );
    await flush();
    expect(last()).toBe('Ping failed: unknown error');

    sendElectronPing(
      id,
      '',
      apiWithPing(async () => {
        throw new Error('ipc down');
      })
    );
    await flush();
    expect(last()).toBe('Ping failed: ipc down');

    sendElectronPing(
      id,
      '',
      apiWithPing(() => Promise.reject('nope'))
    );
    await flush();
    expect(last()).toBe('Ping failed: unknown error');
  });
});
