'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { isElectron as checkIsElectron, getPlatform } from '@/lib/shared/platform';

interface PlatformContextType {
  isElectron: boolean;
  isWeb: boolean;
  platform: 'darwin' | 'win32' | 'linux' | 'web';
  isReady: boolean;
}

const PlatformContext = createContext<PlatformContextType>({
  isElectron: false,
  isWeb: true,
  platform: 'web',
  isReady: false,
});

export function usePlatform() {
  return useContext(PlatformContext);
}

interface PlatformProviderProps {
  children: React.ReactNode;
}

export function PlatformProvider({ children }: PlatformProviderProps) {
  const [platformState, setPlatformState] = useState<PlatformContextType>({
    isElectron: false,
    isWeb: true,
    platform: 'web',
    isReady: false,
  });

  useEffect(() => {
    // Check platform after component mounts (client-side only)
    const isElectronEnv = checkIsElectron();
    const platform = getPlatform();

    setPlatformState({
      isElectron: isElectronEnv,
      isWeb: !isElectronEnv,
      platform,
      isReady: true,
    });
  }, []);

  return <PlatformContext.Provider value={platformState}>{children}</PlatformContext.Provider>;
}

/**
 * Component that only renders its children in Electron environment
 */
export function ElectronOnly({ children }: { children: React.ReactNode }) {
  const { isElectron, isReady } = usePlatform();

  if (!isReady || !isElectron) {
    return null;
  }

  return <>{children}</>;
}

/**
 * Component that only renders its children in web browser environment
 */
export function WebOnly({ children }: { children: React.ReactNode }) {
  const { isWeb, isReady } = usePlatform();

  if (!isReady || !isWeb) {
    return null;
  }

  return <>{children}</>;
}

/**
 * Hook to run effect only on specific platform
 */
export function usePlatformEffect(
  effect: () => void | (() => void),
  platform: 'electron' | 'web' | 'all',
  deps: React.DependencyList = []
) {
  const { isElectron, isReady } = usePlatform();

  useEffect(() => {
    if (!isReady) return;

    if (platform === 'all') {
      return effect();
    }

    if (platform === 'electron' && isElectron) {
      return effect();
    }

    if (platform === 'web' && !isElectron) {
      return effect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, isElectron, platform, ...deps]);
}
