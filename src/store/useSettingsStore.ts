import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AppSettings, ProxyConfig } from '@/types';

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
}

const defaultProxyConfig: ProxyConfig = {
  enabled: false,
  type: 'http',
  host: '',
  port: 8080,
  auth: undefined,
  bypassList: ['localhost', '127.0.0.1', '::1'],
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
  // Security settings - allow localhost by default for development convenience
  allowLocalhost: true,
  allowPrivateIPs: false,
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
    }),
    {
      name: 'app-settings-storage',
    }
  )
);
