import { cleanupConnectionLifecycle } from '@/lib/shared/connection-lifecycle';
import { kafkaManager } from './kafkaManager';
import { useKafkaStore } from '../store/useKafkaStore';

export function cleanupKafkaConnectionForTab(tabId: string): void {
  cleanupConnectionLifecycle(tabId, {
    connectionIdForTab: (id) => useKafkaStore.getState().connectionByTabId[id],
    disconnect: (connectionId) => kafkaManager.disconnect(connectionId),
    removeConnectionForTab: (id) => useKafkaStore.getState().cleanupConnectionForTab(id),
  });
}
