import { isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { AppSettings, ProxyConfig } from '@/types';

export type ExecutionPolicySyncState =
  'unavailable' | 'waiting-for-hydration' | 'syncing' | 'retrying' | 'acknowledged';

interface ExecutionPolicy {
  security: { allowLocalhost: boolean; allowPrivateIPs: boolean };
  proxy: {
    enabled: boolean;
    type: 'none' | 'http' | 'https' | 'socks4' | 'socks5';
    host: string;
    port: number;
    bypassList: string[];
    auth?: ProxyConfig['auth'];
  };
  timeout: number;
  tls: {
    verifySsl: boolean;
    serverCipherOrder: boolean;
    minTlsVersion?: AppSettings['minTlsVersion'];
    cipherSuites?: string;
  };
  certificates: {
    clientCert?: AppSettings['clientCert'];
    caCert?: AppSettings['caCert'];
    clientCertificates: NonNullable<AppSettings['clientCertificates']>;
    caCertificates: NonNullable<AppSettings['caCertificates']>;
  };
}

const RETRY_DELAY_MS = 250;
const defaultProxy: ExecutionPolicy['proxy'] = {
  enabled: false,
  type: 'http',
  host: '',
  port: 8080,
  bypassList: [],
};

let syncState: ExecutionPolicySyncState = 'unavailable';
let initialization: Promise<void> | undefined;
let pendingPolicy: ExecutionPolicy | undefined;
let deliveryInFlight = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function getExecutionPolicySyncState(): ExecutionPolicySyncState {
  return syncState;
}

function readExecutionPolicy(settings = useSettingsStore.getState().settings): ExecutionPolicy {
  const proxy = settings.proxy ?? defaultProxy;
  const nextProxy: ExecutionPolicy['proxy'] = {
    enabled: proxy.enabled === true,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    bypassList: [...(proxy.bypassList ?? [])],
    ...(proxy.auth ? { auth: { ...proxy.auth } } : {}),
  };

  return {
    security: {
      allowLocalhost: settings.allowLocalhost ?? true,
      allowPrivateIPs: settings.allowPrivateIPs === true,
    },
    proxy: nextProxy,
    timeout: settings.defaultTimeout,
    tls: {
      verifySsl: settings.verifySsl,
      serverCipherOrder: settings.serverCipherOrder === true,
      ...(settings.minTlsVersion ? { minTlsVersion: settings.minTlsVersion } : {}),
      ...(settings.cipherSuites ? { cipherSuites: settings.cipherSuites } : {}),
    },
    certificates: {
      ...(settings.clientCert ? { clientCert: { ...settings.clientCert } } : {}),
      ...(settings.caCert ? { caCert: { ...settings.caCert } } : {}),
      clientCertificates: (settings.clientCertificates ?? []).map((entry) => ({
        ...entry,
        cert: { ...entry.cert },
      })),
      caCertificates: (settings.caCertificates ?? []).map((entry) => ({ ...entry })),
    },
  };
}

function policiesEqual(left: ExecutionPolicy, right: ExecutionPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function flushPendingPolicy(): Promise<void> {
  if (deliveryInFlight || !pendingPolicy) return;

  deliveryInFlight = true;
  const policy = pendingPolicy;
  pendingPolicy = undefined;
  syncState = 'syncing';

  try {
    const setExecutionPolicy = window.electron?.security?.setExecutionPolicy;
    if (!setExecutionPolicy) {
      throw new Error('Electron execution-policy IPC is unavailable');
    }
    await setExecutionPolicy(policy);
    syncState = 'acknowledged';
  } catch {
    pendingPolicy = policy;
    syncState = 'retrying';
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void flushPendingPolicy();
    }, RETRY_DELAY_MS);
  } finally {
    deliveryInFlight = false;
  }

  if (pendingPolicy && !retryTimer) {
    await flushPendingPolicy();
  }
}

function queuePolicy(policy: ExecutionPolicy): Promise<void> {
  pendingPolicy = policy;
  if (retryTimer) return Promise.resolve();
  return flushPendingPolicy();
}

async function waitForSettingsHydration(): Promise<void> {
  if (useSettingsStore.persist.hasHydrated()) return;

  syncState = 'waiting-for-hydration';
  await new Promise<void>((resolve) => {
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
    void useSettingsStore.persist.rehydrate();
  });
}

/**
 * Synchronize the complete execution policy only after persisted settings are
 * hydrated. Main acknowledges each accepted policy; rejected delivery is
 * retried automatically so outbound adapters can eventually enforce it.
 */
export function initExecutionPolicySync(): Promise<void> {
  if (!isElectron()) {
    syncState = 'unavailable';
    return Promise.resolve();
  }
  if (initialization) return initialization;

  initialization = (async () => {
    await waitForSettingsHydration();
    let lastPolicy = readExecutionPolicy();
    useSettingsStore.subscribe((state) => {
      const next = readExecutionPolicy(state.settings);
      if (!policiesEqual(next, lastPolicy)) {
        lastPolicy = next;
        void queuePolicy(next);
      }
    });
    await queuePolicy(lastPolicy);
  })();
  return initialization;
}
