import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/features/registry/bootstrap';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import { useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { mqttManager } from '@/features/mqtt/lib/mqttManager';
import { useMqttStore } from '@/features/mqtt/store/useMqttStore';
import { protocolRegistry } from '@/features/registry/registry';
import { socketioManager } from '@/features/socketio/lib/socketioManager';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { websocketManager } from '@/features/websocket/lib/websocketManager';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import { useRequestStore } from '@/store/useRequestStore';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

interface TabConnectionStore {
  getState: () => {
    ensureConnectionForTab: (tabId: string) => string;
    connectionByTabId: Record<string, string>;
    connections: Record<string, unknown>;
  };
}

const PROTOCOLS: {
  id: string;
  store: TabConnectionStore;
  manager: { disconnect: (id: string, ...rest: never[]) => unknown };
  disconnectArgs: (connectionId: string) => unknown[];
}[] = [
  {
    id: 'websocket',
    store: useWebSocketStore as unknown as TabConnectionStore,
    manager: websocketManager,
    // Closing a tab is a manual disconnect: it must not auto-reconnect.
    disconnectArgs: (connectionId) => [connectionId, true],
  },
  {
    id: 'socketio',
    store: useSocketIOStore as unknown as TabConnectionStore,
    manager: socketioManager,
    disconnectArgs: (connectionId) => [connectionId],
  },
  {
    id: 'kafka',
    store: useKafkaStore as unknown as TabConnectionStore,
    manager: kafkaManager,
    disconnectArgs: (connectionId) => [connectionId],
  },
  {
    id: 'mqtt',
    store: useMqttStore as unknown as TabConnectionStore,
    manager: mqttManager,
    disconnectArgs: (connectionId) => [connectionId],
  },
];

function openTabWithConnection(store: TabConnectionStore): { tabId: string; connectionId: string } {
  const tabId = useRequestStore.getState().createNewRequest('http');
  return { tabId, connectionId: store.getState().ensureConnectionForTab(tabId) };
}

describe('closing a tab', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(PROTOCOLS)('$id', ({ id, store, manager, disconnectArgs }) => {
    it('declares its tab connection binding in its registration', () => {
      expect(protocolRegistry.get(id)?.connectionLifecycle).toBeDefined();
    });

    it('disconnects the tab connection and removes it from the store', () => {
      const disconnect = vi.spyOn(manager, 'disconnect').mockImplementation(() => undefined);
      const { tabId, connectionId } = openTabWithConnection(store);

      useRequestStore.getState().closeTab(tabId);

      expect(disconnect).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledWith(...disconnectArgs(connectionId));
      expect(store.getState().connectionByTabId[tabId]).toBeUndefined();
      expect(store.getState().connections[connectionId]).toBeUndefined();
    });

    it('still removes the connection when the disconnect fails', () => {
      vi.spyOn(manager, 'disconnect').mockImplementation(() => {
        throw new Error('already gone');
      });
      const { tabId, connectionId } = openTabWithConnection(store);

      expect(() => useRequestStore.getState().closeTab(tabId)).not.toThrow();

      expect(store.getState().connectionByTabId[tabId]).toBeUndefined();
      expect(store.getState().connections[connectionId]).toBeUndefined();
    });

    it('leaves another tab connection alone', () => {
      const disconnect = vi.spyOn(manager, 'disconnect').mockImplementation(() => undefined);
      const closing = openTabWithConnection(store);
      const staying = openTabWithConnection(store);

      useRequestStore.getState().closeTab(closing.tabId);

      expect(disconnect).not.toHaveBeenCalledWith(staying.connectionId, expect.anything());
      expect(store.getState().connectionByTabId[staying.tabId]).toBe(staying.connectionId);
      useRequestStore.getState().closeTab(staying.tabId);
    });
  });

  it('does not touch any manager for a tab without a connection', () => {
    const spies = PROTOCOLS.map(({ manager }) =>
      vi.spyOn(manager, 'disconnect').mockImplementation(() => undefined)
    );
    const tabId = useRequestStore.getState().createNewRequest('http');

    useRequestStore.getState().closeTab(tabId);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('covers every tab a bulk close removes', () => {
    const spies = PROTOCOLS.map(({ manager }) =>
      vi.spyOn(manager, 'disconnect').mockImplementation(() => undefined)
    );
    for (const { store } of PROTOCOLS) openTabWithConnection(store);

    useRequestStore.getState().closeAllTabs();

    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
  });
});
