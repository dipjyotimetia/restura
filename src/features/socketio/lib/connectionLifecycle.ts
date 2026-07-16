import { cleanupConnectionLifecycle } from '@/lib/shared/connection-lifecycle';
import { useSocketIOStore } from '../store/useSocketIOStore';
import { socketioManager } from './socketioManager';

export function cleanupSocketIOConnectionForTab(tabId: string): void {
  cleanupConnectionLifecycle(tabId, {
    connectionIdForTab: (id) => useSocketIOStore.getState().connectionByTabId[id],
    disconnect: (connectionId) => socketioManager.disconnect(connectionId),
    removeConnectionForTab: (id) => useSocketIOStore.getState().cleanupConnectionForTab(id),
  });
}
