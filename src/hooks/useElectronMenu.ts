'use client';

import { useEffect } from 'react';
import { onMenuEvent, isElectron } from '@/lib/shared/platform';

type MenuEventHandler = () => void;

interface ElectronMenuHandlers {
  onImport?: MenuEventHandler;
  onExport?: MenuEventHandler;
  onNewRequest?: MenuEventHandler;
}

/**
 * Hook to handle Electron menu events
 * Automatically subscribes/unsubscribes from menu events
 */
export function useElectronMenu(handlers: ElectronMenuHandlers): void {
  useEffect(() => {
    if (!isElectron()) {
      return;
    }

    const cleanups: Array<() => void> = [];

    if (handlers.onImport) {
      cleanups.push(onMenuEvent('menu:import', handlers.onImport));
    }

    if (handlers.onExport) {
      cleanups.push(onMenuEvent('menu:export', handlers.onExport));
    }

    if (handlers.onNewRequest) {
      cleanups.push(onMenuEvent('menu:new-request', handlers.onNewRequest));
    }

    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [handlers.onImport, handlers.onExport, handlers.onNewRequest]);
}

/**
 * Hook to detect if running in Electron
 */
export function useIsElectron(): boolean {
  return typeof window !== 'undefined' && isElectron();
}
