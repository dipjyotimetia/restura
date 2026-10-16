import { decodeWsBinaryFrame, encodeWsBinaryFrame } from '@shared/protocol/ws-binary-codec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Desktop binary frames (#897) and hex compose validation (#912).
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => true,
  getElectronAPI: vi.fn(),
}));

import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { getElectronAPI } from '@/lib/shared/platform';
import { websocketManager } from '../websocketManager';

type Listener = (payload?: unknown) => void;

function installFakeWsApi() {
  const listeners = new Map<string, Listener>();
  const send = vi.fn(async (_cfg: { connectionId: string; message: string; binary?: boolean }) => ({
    success: true,
  }));
  const websocket = {
    connect: vi.fn(async () => ({ success: true })),
    send,
    disconnect: vi.fn(async () => ({ success: true })),
    on: vi.fn((channel: string, cb: Listener) => {
      listeners.set(channel, cb);
    }),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn((channel: string) => {
      listeners.delete(channel);
    }),
  };
  vi.mocked(getElectronAPI).mockReturnValue({ websocket } as never);
  return { send, emit: (channel: string, payload?: unknown) => listeners.get(channel)?.(payload) };
}

const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

describe('WebSocketManager desktop binary frames over IPC (#897)', () => {
  let connectionId: string;
  let api: ReturnType<typeof installFakeWsApi>;

  beforeEach(() => {
    api = installFakeWsApi();
    connectionId = useWebSocketStore.getState().createConnection();
    websocketManager.connect(connectionId, 'ws://localhost:9999/echo');
    api.emit(`ws:open:${connectionId}`);
  });

  afterEach(() => {
    websocketManager.disconnect(connectionId, false);
    useWebSocketStore.getState().removeConnection(connectionId);
    vi.clearAllMocks();
  });

  it('sends binary frames to main as base64, byte-for-byte', () => {
    expect(websocketManager.send(connectionId, ALL_BYTES.slice().buffer)).toBe(true);

    const cfg = api.send.mock.calls[0]![0];
    expect(cfg.binary).toBe(true);
    expect(cfg.message).toBe(Buffer.from(ALL_BYTES).toString('base64'));
    expect(Array.from(decodeWsBinaryFrame(cfg.message))).toEqual(Array.from(ALL_BYTES));
  });

  it('keeps hex as the display format for sent binary frames', () => {
    websocketManager.send(connectionId, new Uint8Array([0x00, 0xff, 0x48]).buffer);
    const last = useWebSocketStore.getState().connections[connectionId]!.messages.at(-1)!;
    expect(last.dataType).toBe('binary');
    expect(last.content).toBe('00 ff 48');
  });

  it('decodes received base64 binary frames into the exact bytes and hex display', () => {
    api.emit(`ws:message:${connectionId}`, {
      type: 'binary',
      data: encodeWsBinaryFrame(ALL_BYTES),
    });
    const last = useWebSocketStore.getState().connections[connectionId]!.messages.at(-1)!;
    expect(last.type).toBe('received');
    expect(last.dataType).toBe('binary');
    expect(Array.from(new Uint8Array(last.binaryData!))).toEqual(Array.from(ALL_BYTES));
    expect(last.content.split(' ')).toHaveLength(256);
    expect(last.content.startsWith('00 01 02')).toBe(true);
    expect(last.content.endsWith('fe ff')).toBe(true);
  });

  it('surfaces a malformed binary payload as a system message instead of storing garbage', () => {
    api.emit(`ws:message:${connectionId}`, { type: 'binary', data: '48 69' });
    const msgs = useWebSocketStore.getState().connections[connectionId]!.messages;
    expect(msgs.some((m) => m.type === 'received')).toBe(false);
    expect(msgs.at(-1)!.type).toBe('system');
  });
});

describe('WebSocketManager.hexToArrayBuffer validation (#912)', () => {
  it.each(['zz', '123', 'g1', '48 zz 65', 'f', '0x48'])('rejects invalid hex %j', (input) => {
    expect(() => websocketManager.hexToArrayBuffer(input)).toThrow(/hex/i);
  });

  it('parses valid space-separated hex unchanged', () => {
    expect(Array.from(new Uint8Array(websocketManager.hexToArrayBuffer('48 65 6C 6c 6f')))).toEqual(
      [0x48, 0x65, 0x6c, 0x6c, 0x6f]
    );
    expect(Array.from(new Uint8Array(websocketManager.hexToArrayBuffer(' 00\tff\n01 ')))).toEqual([
      0x00, 0xff, 0x01,
    ]);
  });
});
