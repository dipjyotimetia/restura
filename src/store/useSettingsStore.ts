import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AppSettings,
  ProxyConfig,
  CorsProxyConfig,
  ClientCert,
  CaCert,
  HostClientCert,
  HostCaCert,
  JudgeSettings,
} from '@/types';
import type { SecretValue } from '@/lib/shared/secretRef';
import { DEFAULT_AUTO_UPDATE_SETTINGS, DEFAULT_JUDGE_SETTINGS } from '@/types';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { migrateLegacyLocalStorage } from '@/lib/shared/migrate-legacy-storage';

interface SettingsState {
  settings: AppSettings;

  // Actions
  updateSettings: (updates: Partial<AppSettings>) => void;
  updateProxy: (updates: Partial<ProxyConfig>) => void;
  resetSettings: () => void;
  setProxyEnabled: (enabled: boolean) => void;
  setProxyAuth: (username: string, password: SecretValue) => void;
  clearProxyAuth: () => void;
  addBypassHost: (host: string) => void;
  removeBypassHost: (host: string) => void;
  // CORS proxy actions
  updateCorsProxy: (updates: Partial<CorsProxyConfig>) => void;
  setCorsProxyEnabled: (enabled: boolean) => void;
  // Semantic-assertion judge actions
  updateJudge: (updates: Partial<JudgeSettings>) => void;
  // Certificate actions
  setClientCert: (cert: ClientCert | undefined) => void;
  setCaCert: (ca: CaCert | undefined) => void;
  // Per-domain certificate actions (desktop-only)
  upsertHostClientCert: (entry: HostClientCert) => void;
  removeHostClientCert: (id: string) => void;
  upsertHostCaCert: (entry: HostCaCert) => void;
  removeHostCaCert: (id: string) => void;
}

// EOPT: omit optional fields rather than initialising them to undefined.
const defaultProxyConfig: ProxyConfig = {
  enabled: false,
  type: 'http',
  host: '',
  port: 8080,
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
  layoutOrientation: 'horizontal',
  // Security settings - allow localhost by default for development convenience
  allowLocalhost: true,
  allowPrivateIPs: false,
  // CORS proxy settings for web mode
  corsProxy: defaultCorsProxyConfig,
  // Telemetry defaults to ON (opt-out): error reports are sent to
  // /api/telemetry/error (web) and Sentry (desktop). Users can disable it; the
  // flag is mirrored to the Electron main process to gate Sentry.
  telemetry: { errorsEnabled: true },
  // Spatial Depth default accent — richer cobalt
  accent: '#2e91ff',
  // Desktop auto-updater: download in the background on the stable channel.
  autoUpdate: DEFAULT_AUTO_UPDATE_SETTINGS,
  // Semantic-assertion judge (rs.judge). Safe-by-default; see DEFAULT_JUDGE_SETTINGS.
  judge: DEFAULT_JUDGE_SETTINGS,
  // clientCert and caCert intentionally omitted (optional under EOPT)
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

      resetSettings: () => set({ settings: defaultSettings }),

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
        set((state) => {
          // EOPT: omit `auth` instead of setting it to undefined.
          const { auth: _omit, ...rest } = state.settings.proxy;
          void _omit;
          return {
            settings: {
              ...state.settings,
              proxy: rest,
            },
          };
        }),

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
              bypassList: (state.settings.proxy.bypassList || []).filter((h) => h !== host),
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

      updateJudge: (updates) =>
        set((state) => {
          // Merge over the persisted value or the defaults (pre-judge persisted
          // state has no `judge` field).
          const current: JudgeSettings = state.settings.judge ?? DEFAULT_JUDGE_SETTINGS;
          return {
            settings: { ...state.settings, judge: { ...current, ...updates } },
          };
        }),

      setClientCert: (cert) =>
        set((s) => {
          // EOPT: omit `clientCert` when clearing rather than setting undefined.
          const { clientCert: _omit, ...rest } = s.settings;
          void _omit;
          return {
            settings: cert === undefined ? rest : { ...rest, clientCert: cert },
          };
        }),

      setCaCert: (ca) =>
        set((s) => {
          // EOPT: omit `caCert` when clearing rather than setting undefined.
          const { caCert: _omit, ...rest } = s.settings;
          void _omit;
          return {
            settings: ca === undefined ? rest : { ...rest, caCert: ca },
          };
        }),

      upsertHostClientCert: (entry) =>
        set((s) => {
          const list = s.settings.clientCertificates ?? [];
          const idx = list.findIndex((c) => c.id === entry.id);
          const next =
            idx >= 0 ? list.map((c) => (c.id === entry.id ? entry : c)) : [...list, entry];
          return { settings: { ...s.settings, clientCertificates: next } };
        }),

      removeHostClientCert: (id) =>
        set((s) => ({
          settings: {
            ...s.settings,
            clientCertificates: (s.settings.clientCertificates ?? []).filter((c) => c.id !== id),
          },
        })),

      upsertHostCaCert: (entry) =>
        set((s) => {
          const list = s.settings.caCertificates ?? [];
          const idx = list.findIndex((c) => c.id === entry.id);
          const next =
            idx >= 0 ? list.map((c) => (c.id === entry.id ? entry : c)) : [...list, entry];
          return { settings: { ...s.settings, caCertificates: next } };
        }),

      removeHostCaCert: (id) =>
        set((s) => ({
          settings: {
            ...s.settings,
            caCertificates: (s.settings.caCertificates ?? []).filter((c) => c.id !== id),
          },
        })),
    }),
    {
      name: 'app-settings-storage',
      version: 4, // v4: default request/response layout flipped to horizontal
      storage: dexieStorageAdapters.settings(),
      migrate: (persistedState, _version) => {
        const looksEmpty =
          !persistedState ||
          (typeof persistedState === 'object' &&
            Object.keys(persistedState as object).length === 0);
        let resolved = persistedState as SettingsState;
        if (looksEmpty) {
          const legacy = migrateLegacyLocalStorage<Partial<SettingsState>>('app-settings-storage');
          if (legacy) resolved = legacy as SettingsState;
        }
        // v3→v4: the default layout changed from vertical to horizontal. v3
        // persisted a concrete 'vertical' default, so a deliberate vertical
        // choice is indistinguishable from the old default — this one-time flip
        // therefore resets ALL vertical users to horizontal. Acceptable for a
        // cosmetic, toggle-reversible setting; anyone who wants vertical back
        // re-picks it via the response-header toggle / settings.
        if (resolved?.settings?.layoutOrientation === 'vertical') {
          resolved = {
            ...resolved,
            settings: { ...resolved.settings, layoutOrientation: 'horizontal' },
          };
        }
        return resolved;
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
