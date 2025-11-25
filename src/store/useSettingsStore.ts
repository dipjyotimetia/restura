import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AppSettings, ProxyConfig, CorsProxyConfig } from '@/types';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';

interface SettingsState {
  settings: AppSettings;

  // Actions
  updateSettings: (updates: Partial<AppSettings>) => void;
  updateProxy: (updates: Partial<ProxyConfig>) => void;
  resetSettings: () => void;
  setProxyEnabled: (enabled: boolean) => void;
  setProxyAuth: (username: string, password: string) => void;
  clearProxyAuth: () => void;
  addBypassHost: (host: string) => void;
  removeBypassHost: (host: string) => void;
  // CORS proxy actions
  updateCorsProxy: (updates: Partial<CorsProxyConfig>) => void;
  setCorsProxyEnabled: (enabled: boolean) => void;
}

const defaultProxyConfig: ProxyConfig = {
  enabled: false,
  type: 'http',
  host: '',
  port: 8080,
  auth: undefined,
  bypassList: ['localhost', '127.0.0.1', '::1'],
};

const defaultCorsProxyConfig: CorsProxyConfig = {
  enabled: true, // Enable by default for browser mode
  autoDetect: true,
};

const defaultSettings: AppSettings = {
  proxy: defaultProxyConfig,
  defaultTimeout: 30000, // 30 seconds
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
  autoSaveHistory: true,
  maxHistoryItems: 100,
  theme: 'dark',
  // Layout settings
  layoutOrientation: 'vertical',
  // Security settings - allow localhost by default for development convenience
  allowLocalhost: true,
  allowPrivateIPs: false,
  // CORS proxy settings for web mode
  corsProxy: defaultCorsProxyConfig,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: defaultSettings,

      updateSettings: (updates) =>
        set((state) => ({
          settings: { ...state.settings, ...updates },
        })),

      updateProxy: (updates) =>
        set((state) => ({
          settings: {
            ...state.settings,
            proxy: { ...state.settings.proxy, ...updates },
          },
        })),

      resetSettings: () =>
        set({ settings: defaultSettings }),

      setProxyEnabled: (enabled) =>
        set((state) => ({
          settings: {
            ...state.settings,
            proxy: { ...state.settings.proxy, enabled },
          },
        })),

      setProxyAuth: (username, password) =>
        set((state) => ({
          settings: {
            ...state.settings,
            proxy: {
              ...state.settings.proxy,
              auth: { username, password },
            },
          },
        })),

      clearProxyAuth: () =>
        set((state) => ({
          settings: {
            ...state.settings,
            proxy: {
              ...state.settings.proxy,
              auth: undefined,
            },
          },
        })),

      addBypassHost: (host) =>
        set((state) => {
          const currentList = state.settings.proxy.bypassList || [];
          if (currentList.includes(host)) {
            return state;
          }
          return {
            settings: {
              ...state.settings,
              proxy: {
                ...state.settings.proxy,
                bypassList: [...currentList, host],
              },
            },
          };
        }),

      removeBypassHost: (host) =>
        set((state) => ({
          settings: {
            ...state.settings,
            proxy: {
              ...state.settings.proxy,
              bypassList: (state.settings.proxy.bypassList || []).filter(
                (h) => h !== host
              ),
            },
          },
        })),

      updateCorsProxy: (updates) =>
        set((state) => ({
          settings: {
            ...state.settings,
            corsProxy: { ...state.settings.corsProxy, ...updates },
          },
        })),

      setCorsProxyEnabled: (enabled) =>
        set((state) => ({
          settings: {
            ...state.settings,
            corsProxy: { ...state.settings.corsProxy, enabled },
          },
        })),
    }),
    {
      name: 'app-settings-storage',
      version: 2, // Bumped for Dexie migration
      storage: dexieStorageAdapters.settings(),
      migrate: (persistedState, version) => {
        if (version === 0 || version === 1) {
          // Migration from localStorage (v1) to Dexie (v2)
          return persistedState as SettingsState;
        }
        return persistedState as SettingsState;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('Settings store rehydration failed:', error);
        }
        if (state) {
          console.debug('Settings store rehydrated from Dexie successfully');
        }
      },
    }
  )
);
