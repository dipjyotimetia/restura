import { cleanupConnectionLifecycle } from '@/lib/shared/connection-lifecycle';
import { useKafkaStore } from '../store/useKafkaStore';
import { kafkaManager } from './kafkaManager';

export function cleanupKafkaConnectionForTab(tabId: string): void {
  cleanupConnectionLifecycle(tabId, {
    connectionIdForTab: (id) => useKafkaStore.getState().connectionByTabId[id],
    disconnect: (connectionId) => kafkaManager.disconnect(connectionId),
    removeConnectionForTab: (id) => useKafkaStore.getState().cleanupConnectionForTab(id),
  });
}
