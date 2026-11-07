import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaProtocol } from '@/features/kafka/protocol';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { mqttProtocol } from '@/features/mqtt/protocol';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { socketioProtocol } from '@/features/socketio/protocol';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { sseManager } from '@/features/sse/lib/sseManager';
import { sseProtocol } from '@/features/sse/protocol';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { websocketProtocol } from '@/features/websocket/protocol';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { cleanupConnectionLifecycle } from '@/lib/shared/connection-lifecycle';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

interface StatusStore {
  getState: () => {
    ensureConnectionForTab: (tabId: string) => string;
    connectionByTabId: Record<string, string>;
    connections: Record<string, unknown>;
  };
  setState: (fn: (s: { connections: Record<string, { status: string }> }) => unknown) => void;
}

function setStatus(store: StatusStore, id: string, status: string) {
  store.setState((s) => ({
    connections: { ...s.connections, [id]: { ...s.connections[id], status } },
  }));
}

const CASES = [
  { name: 'websocket', mod: websocketProtocol, store: useWebSocketStore },
  { name: 'socketio', mod: socketioProtocol, store: useSocketIOStore },
  { name: 'mqtt', mod: mqttProtocol, store: useMqttStore },
  { name: 'kafka', mod: kafkaProtocol, store: useKafkaStore },
  { name: 'sse', mod: sseProtocol, store: useSseStore },
] as const;

describe.each(CASES)('$name connectionLifecycle.isLive', ({ mod, store }) => {
  const s = store as unknown as StatusStore;
  it('is false without a connection, true while connecting/connected, false once disconnected', () => {
    const isLive = mod.connectionLifecycle?.isLive;
    expect(isLive).toBeTypeOf('function');
    if (!isLive) return;
    expect(isLive('no-such-tab')).toBe(false);
    const tabId = `tab-${Math.random()}`;
    const id = s.getState().ensureConnectionForTab(tabId);
    expect(isLive(tabId)).toBe(false);
    setStatus(s, id, 'connecting');
    expect(isLive(tabId)).toBe(true);
    setStatus(s, id, 'connected');
    expect(isLive(tabId)).toBe(true);
    setStatus(s, id, 'disconnected');
    expect(isLive(tabId)).toBe(false);
  });
});

describe('SSE per-tab connections', () => {
  beforeEach(() => {
    useSseStore.setState({
      connections: {},
      summaries: {},
      activeConnectionId: null,
      connectionByTabId: {},
    });
  });

  it('gives each tab its own connection and reuses it on return', () => {
    const { ensureConnectionForTab } = useSseStore.getState();
    const a = ensureConnectionForTab('tab-a');
    const b = ensureConnectionForTab('tab-b');
    expect(a).not.toBe(b);
    expect(ensureConnectionForTab('tab-a')).toBe(a);
    expect(useSseStore.getState().activeConnectionId).toBe(a);
  });

  it('closing the tab disconnects its stream and drops the connection', () => {
    const disconnect = vi.spyOn(sseManager, 'disconnect').mockImplementation(() => undefined);
    const a = useSseStore.getState().ensureConnectionForTab('tab-a');
    const b = useSseStore.getState().ensureConnectionForTab('tab-b');
    const lifecycle = sseProtocol.connectionLifecycle;
    expect(lifecycle).toBeDefined();
    if (!lifecycle) return;
    cleanupConnectionLifecycle('tab-a', lifecycle);
    expect(disconnect).toHaveBeenCalledWith(a);
    expect(useSseStore.getState().connections[a]).toBeUndefined();
    expect(useSseStore.getState().connectionByTabId['tab-a']).toBeUndefined();
    expect(useSseStore.getState().connections[b]).toBeDefined();
    disconnect.mockRestore();
  });

  it('counts events dropped by the 1,000-entry cap and resets on clear', () => {
    const id = useSseStore.getState().ensureConnectionForTab('tab-a');
    for (let i = 0; i < 1003; i++) {
      useSseStore.getState().appendEvent(id, { event: 'message', data: String(i) });
    }
    const c = useSseStore.getState().connections[id];
    expect(c?.log).toHaveLength(1000);
    expect(c?.droppedCount).toBe(3);
    useSseStore.getState().clearLog(id);
    expect(useSseStore.getState().connections[id]?.droppedCount ?? 0).toBe(0);
  });
});
