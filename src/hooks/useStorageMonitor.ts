/**
 * Hook for monitoring IndexedDB (Dexie) storage usage and providing alerts
 */

import { useState, useEffect, useCallback } from 'react';
import { getDexieStorageStats } from '@/lib/shared/dexie-storage';
import { useHistoryStore } from '@/store/useHistoryStore';

interface StorageStatus {
  used: number;
  available: number;
  percentage: number;
  level: 'ok' | 'warning' | 'critical';
  message?: string;
}

interface UseStorageMonitorOptions {
  warningThreshold?: number; // Percentage (default: 70)
  criticalThreshold?: number; // Percentage (default: 90)
  autoPrune?: boolean; // Auto-prune history when critical
  pollInterval?: number; // Check interval in ms (default: 30000)
}

export function useStorageMonitor(options: UseStorageMonitorOptions = {}) {
  const {
    warningThreshold = 70,
    criticalThreshold = 90,
    autoPrune = true,
    pollInterval = 30000,
  } = options;

  const [status, setStatus] = useState<StorageStatus>({
    used: 0,
    available: 0,
    percentage: 0,
    level: 'ok',
  });

  const deleteHistoryItem = useHistoryStore((state) => state.deleteHistoryItem);
  const history = useHistoryStore((state) => state.history);

  const checkStorage = useCallback(async () => {
    try {
      const stats = await getDexieStorageStats();

      // Estimate available space (IndexedDB typically allows much more than localStorage)
      // Use browser storage estimate if available
      let availableBytes = 100 * 1024 * 1024; // Default 100MB estimate
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        if (estimate.quota) {
          availableBytes = estimate.quota;
        }
      }

      const percentage = (stats.estimatedSize / availableBytes) * 100;

      let level: StorageStatus['level'] = 'ok';
      let message: string | undefined;

      if (percentage >= criticalThreshold) {
        level = 'critical';
        message = `Storage is almost full (${percentage.toFixed(1)}%). Consider clearing old history or exporting data.`;
      } else if (percentage >= warningThreshold) {
        level = 'warning';
        message = `Storage usage is high (${percentage.toFixed(1)}%).`;
      }

      setStatus({
        used: stats.estimatedSize,
        available: availableBytes,
        percentage: Math.round(percentage * 100) / 100,
        level,
        message,
      });

      return { used: stats.estimatedSize, available: availableBytes, percentage, level, message };
    } catch (error) {
      console.error('Failed to check storage:', error);
      return { used: 0, available: 0, percentage: 0, level: 'ok' as const, message: undefined };
    }
  }, [criticalThreshold, warningThreshold]);

  const pruneOldHistory = useCallback(
    (itemsToRemove: number = 10) => {
      if (history.length <= itemsToRemove) return 0;

      // Sort by timestamp ascending (oldest first)
      const sortedHistory = [...history].sort((a, b) => a.timestamp - b.timestamp);

      // Remove oldest items that are not favorites
      let removed = 0;
      const favorites = useHistoryStore.getState().favorites;

      for (const item of sortedHistory) {
        if (removed >= itemsToRemove) break;
        if (!favorites.includes(item.id)) {
          deleteHistoryItem(item.id);
          removed++;
        }
      }

      return removed;
    },
    [history, deleteHistoryItem]
  );

  const handleAutoPrune = useCallback(async () => {
    if (!autoPrune) return;

    const stats = await getDexieStorageStats();
    let availableBytes = 100 * 1024 * 1024;
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      if (estimate.quota) {
        availableBytes = estimate.quota;
      }
    }

    const percentage = (stats.estimatedSize / availableBytes) * 100;

    if (percentage >= criticalThreshold) {
      // Remove 20% of history items or at least 10
      const toRemove = Math.max(10, Math.floor(history.length * 0.2));
      const removed = pruneOldHistory(toRemove);
      if (removed > 0) {
        console.log(`Auto-pruned ${removed} old history items to free up storage`);
        await checkStorage(); // Recheck after pruning
      }
    }
  }, [autoPrune, criticalThreshold, history.length, pruneOldHistory, checkStorage]);

  // Initial check
  useEffect(() => {
    checkStorage();
    handleAutoPrune();
  }, [checkStorage, handleAutoPrune]);

  // Periodic monitoring
  useEffect(() => {
    const interval = setInterval(() => {
      checkStorage();
      handleAutoPrune();
    }, pollInterval);

    return () => clearInterval(interval);
  }, [checkStorage, handleAutoPrune, pollInterval]);

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  return {
    status,
    checkStorage,
    pruneOldHistory,
    formatBytes,
    formattedUsed: formatBytes(status.used),
    formattedAvailable: formatBytes(status.available),
  };
}

/**
 * Simple function to get current storage status
 * For use outside of React components
 */
export async function getStorageStatus(): Promise<StorageStatus> {
  try {
    const stats = await getDexieStorageStats();

    let availableBytes = 100 * 1024 * 1024;
    if (typeof navigator !== 'undefined' && 'storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      if (estimate.quota) {
        availableBytes = estimate.quota;
      }
    }

    const percentage = (stats.estimatedSize / availableBytes) * 100;

    let level: StorageStatus['level'] = 'ok';
    let message: string | undefined;

    if (percentage >= 90) {
      level = 'critical';
      message = `Storage is almost full (${percentage.toFixed(1)}%)`;
    } else if (percentage >= 70) {
      level = 'warning';
      message = `Storage usage is high (${percentage.toFixed(1)}%)`;
    }

    return {
      used: stats.estimatedSize,
      available: availableBytes,
      percentage: Math.round(percentage * 100) / 100,
      level,
      message,
    };
  } catch {
    return {
      used: 0,
      available: 0,
      percentage: 0,
      level: 'ok',
    };
  }
}
