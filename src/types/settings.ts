import type { Provider } from '@shared/protocol/ai/types';
import type {
  ProxyConfig,
  ClientCert,
  CaCert,
  HostClientCert,
  HostCaCert,
  MinTlsVersion,
} from './security';

// CORS Proxy Configuration (for browser mode)
export interface CorsProxyConfig {
  enabled: boolean;
  autoDetect: boolean; // Auto-enable when CORS error detected
}

// Global Application Settings
export interface AppSettings {
  proxy: ProxyConfig;
  defaultTimeout: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifySsl: boolean;
  autoSaveHistory: boolean;
  maxHistoryItems: number;
  theme: 'light' | 'dark' | 'system';
  // Layout settings
  layoutOrientation: 'vertical' | 'horizontal';
  // Request/response split ratio as a percentage of the first (request) panel.
  // Persisted so the divider position survives reload. Optional: pre-existing
  // persisted settings predate it and fall back to a 50/50 default in the UI.
  requestResponseSplit?: number;
  // Security settings
  allowLocalhost?: boolean;
  allowPrivateIPs?: boolean;
  // CORS proxy settings (web-only)
  corsProxy: CorsProxyConfig;
  // Certificate settings (global — applied to every HTTPS request)
  clientCert?: ClientCert;
  caCert?: CaCert;
  // Per-domain certificates (desktop-only). Matched most-specific-first by
  // `certMatcher.selectCertForUrl`; a match takes precedence over the global
  // clientCert/caCert above for that host.
  clientCertificates?: HostClientCert[];
  caCertificates?: HostCaCert[];
  // Redirect policy defaults — mirrors RequestSettings; per-request settings still override these.
  followOriginalMethod?: boolean;
  followAuthHeader?: boolean;
  stripReferer?: boolean;
  // URL & cookie defaults
  encodeUrlAutomatically?: boolean;
  disableCookieJar?: boolean;
  // TLS defaults (desktop-only enforcement)
  serverCipherOrder?: boolean;
  minTlsVersion?: MinTlsVersion;
  cipherSuites?: string;
  // Telemetry (Gap #2c). Defaults to ON (opt-out). Gates the renderer→Worker
  // error sink (web) and, on desktop, Sentry crash/error reporting (native
  // minidumps + main/renderer JS errors) — never request payloads, headers, or
  // response bodies. The flag is mirrored to the Electron main process so it can
  // gate Sentry; see electron/main/lifecycle/sentry.ts and electron/main/lifecycle/telemetry-consent.ts.
  telemetry?: {
    errorsEnabled: boolean;
  };
  // Spatial Depth accent preset; drives --sp-accent CSS variable
  accent?: SpatialAccent;
  // Desktop auto-updater preferences (Electron only). Synced to the main
  // process via window.electron.updater.setConfig. `beta` maps to prerelease.
  autoUpdate?: AutoUpdateSettings;
  // Semantic-assertion judge (rs.judge in test scripts). Desktop-only for now
  // (web has no /api/ai route). See src/lib/shared/judgeBridge.ts.
  judge?: JudgeSettings;
}

/**
 * Config for the LLM-as-judge backing `rs.judge(...)` in test scripts.
 * Consumed by `makeRendererJudge` in `src/lib/shared/judgeBridge.ts`.
 */
export interface JudgeSettings {
  enabled: boolean;
  provider: Provider;
  model: string;
  /** SecretRef handle id for the provider API key (absent for keyless local runtimes). */
  apiKeyHandleId?: string;
  /** Base URL override; required by the IPC for local providers (ollama/openai-compatible). */
  baseUrl?: string;
  /** Redact the candidate output before sending it to the judge LLM. Default true. */
  redactBeforeJudge: boolean;
}

/**
 * Single source of truth for the default judge config. Referenced by the
 * settings-store default, its `updateJudge` fallback (pre-judge persisted state
 * lacks the field), and the settings UI. Off by default; redact-before-judge ON
 * (don't ship raw API responses to a cloud LLM unprompted).
 */
export const DEFAULT_JUDGE_SETTINGS: JudgeSettings = {
  enabled: false,
  provider: 'openai',
  model: '',
  redactBeforeJudge: true,
};

export interface AutoUpdateSettings {
  autoDownload: boolean;
  channel: 'stable' | 'beta';
}

/** Single source of truth for the default auto-updater preferences. */
export const DEFAULT_AUTO_UPDATE_SETTINGS: AutoUpdateSettings = {
  autoDownload: true,
  channel: 'stable',
};

export type SpatialAccent = '#2e91ff' | '#7c5cff' | '#22c55e' | '#f59e0b' | '#ef4444' | '#06b6d4';

export const SPATIAL_ACCENT_PRESETS: ReadonlyArray<SpatialAccent> = [
  '#2e91ff',
  '#7c5cff',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
];

// Alias for backwards compatibility and clarity
export type GlobalSettings = AppSettings;

// Active sidebar panel
export type ActivePanel = 'collections' | 'history' | 'workflows' | 'runs';
