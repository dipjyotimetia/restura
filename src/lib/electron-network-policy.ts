import { isElectron } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import type {
  AppSettings,
  CaCert,
  ClientCert,
  HostCaCert,
  HostClientCert,
  MinTlsVersion,
  ProxyConfig,
} from '@/types';

/**
 * Push the Settings → Security outbound-network policy to the Electron main
 * process so every SSRF guard (HTTP, WebSocket, SSE, Socket.IO, gRPC, MCP)
 * shares one policy. Mirrors the telemetry-consent sync (electron-sentry.ts):
 * push once at startup, then forward every change.
 *
 * The store rehydrates from Dexie asynchronously, so the initial push may carry
 * the defaults (localhost allowed, private blocked); the subscription catches
 * the rehydrated value once it differs. Main defaults to the same baseline, so
 * the brief pre-push window fails *closed* for a user who enabled private IPs
 * (they stay blocked until the push lands) but fails *open* for a user who
 * disabled localhost (loopback is transiently reachable until the push). The
 * latter is not a regression — before this policy existed these transports
 * permanently allowed localhost — and HTTP is still covered by the renderer's
 * own pre-flight validateURL, which reads the setting synchronously. Defaulting
 * main to localhost-blocked instead would break the common (localhost-allowed)
 * case on every launch, so the transient is accepted.
 */

let subscribed = false;

interface ExecutionPolicy {
  allowLocalhost: boolean;
  allowPrivateIPs: boolean;
  proxy: ProxyConfig & { bypassList: string[] };
  defaultTimeout: number;
  verifySsl: boolean;
  clientCert?: ClientCert;
  caCert?: CaCert;
  clientCertificates: HostClientCert[];
  caCertificates: HostCaCert[];
  serverCipherOrder?: boolean;
  minTlsVersion?: MinTlsVersion;
  cipherSuites?: string;
}

function readPolicy(s: AppSettings = useSettingsStore.getState().settings): ExecutionPolicy {
  return {
    allowLocalhost: s.allowLocalhost ?? true,
    allowPrivateIPs: s.allowPrivateIPs === true,
    proxy: {
      enabled: s.proxy?.enabled ?? false,
      type: s.proxy?.type ?? 'http',
      host: s.proxy?.host ?? '',
      port: s.proxy?.port ?? 8080,
      bypassList: s.proxy?.bypassList ?? [],
      ...(s.proxy?.auth ? { auth: s.proxy.auth } : {}),
    },
    defaultTimeout: s.defaultTimeout ?? 30_000,
    verifySsl: s.verifySsl ?? true,
    ...(s.clientCert ? { clientCert: s.clientCert } : {}),
    ...(s.caCert ? { caCert: s.caCert } : {}),
    clientCertificates: s.clientCertificates ?? [],
    caCertificates: s.caCertificates ?? [],
    ...(s.serverCipherOrder !== undefined ? { serverCipherOrder: s.serverCipherOrder } : {}),
    ...(s.minTlsVersion ? { minTlsVersion: s.minTlsVersion } : {}),
    ...(s.cipherSuites ? { cipherSuites: s.cipherSuites } : {}),
  };
}

function pushPolicy(policy: ExecutionPolicy): void {
  // Best-effort; a failed push must never break the app (main keeps its last value).
  void window.electron?.security?.setExecutionPolicy(policy);
}

function policyEquals(a: ExecutionPolicy | undefined, b: ExecutionPolicy): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export function initNetworkPolicySync(): void {
  if (!isElectron() || subscribed) return;
  subscribed = true;
  let last: ExecutionPolicy | undefined;
  const sync = (settings?: AppSettings) => {
    const next = readPolicy(settings);
    if (!policyEquals(last, next)) {
      last = next;
      pushPolicy(next);
    }
  };

  useSettingsStore.subscribe((state) => {
    sync(state.settings);
  });

  // State persistence rehydrates asynchronously. Wait for it when available,
  // otherwise push synchronously for test/non-persisted stores.
  const persistence = useSettingsStore.persist;
  if (persistence?.hasHydrated?.() === false && persistence.onFinishHydration) {
    persistence.onFinishHydration(() => sync());
  } else {
    sync();
  }
}
