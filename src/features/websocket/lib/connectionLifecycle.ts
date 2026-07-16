import { cleanupConnectionLifecycle } from '@/lib/shared/connection-lifecycle';
import { useWebSocketStore } from '../store/useWebSocketStore';
import { websocketManager } from './websocketManager';

export function cleanupWebSocketConnectionForTab(tabId: string): void {
  cleanupConnectionLifecycle(tabId, {
    connectionIdForTab: (id) => useWebSocketStore.getState().connectionByTabId[id],
    disconnect: (connectionId) => websocketManager.disconnect(connectionId, true),
    removeConnectionForTab: (id) => useWebSocketStore.getState().cleanupConnectionForTab(id),
  });
}
