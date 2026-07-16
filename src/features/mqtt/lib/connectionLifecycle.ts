import { cleanupConnectionLifecycle } from '@/lib/shared/connection-lifecycle';
import { useMqttStore } from '../store/useMqttStore';
import { mqttManager } from './mqttManager';

export function cleanupMqttConnectionForTab(tabId: string): void {
  cleanupConnectionLifecycle(tabId, {
    connectionIdForTab: (id) => useMqttStore.getState().connectionByTabId[id],
    disconnect: (connectionId) => mqttManager.disconnect(connectionId),
    removeConnectionForTab: (id) => useMqttStore.getState().cleanupConnectionForTab(id),
  });
}
