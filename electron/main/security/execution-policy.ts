import { ipcMain } from 'electron';
import { selectCertForUrl } from '../../../src/lib/shared/certMatcher';
import type { SecretValue } from '../../../src/lib/shared/secretRef';
import { IPC } from '../../shared/channels';
import { createValidatedHandler, ExecutionPolicySchema } from '../ipc/ipc-validators';

export { ExecutionPolicySchema } from '../ipc/ipc-validators';

type ProxyType = 'none' | 'http' | 'https' | 'socks4' | 'socks5';
type MinTlsVersion = 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';

export interface ExecutionProxy {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  bypassList: string[];
  auth?: { username: string; password: SecretValue };
}

export interface ExecutionClientCert {
  format: 'pfx' | 'pem';
  pfx?: string;
  cert?: string;
  key?: string;
  /** Kept opaque until a transport resolves it at wire time. */
  passphrase?: SecretValue;
}

export interface ExecutionCaCert {
  pem: string;
}

export interface HostExecutionClientCert {
  id: string;
  host: string;
  port?: number;
  cert: ExecutionClientCert;
}

export interface HostExecutionCaCert {
  id: string;
  host: string;
  port?: number;
  pem: string;
}

/** Immutable main-process snapshot of every global desktop execution setting. */
export interface ExecutionPolicy {
  allowLocalhost: boolean;
  allowPrivateIPs: boolean;
  proxy: ExecutionProxy;
  defaultTimeout: number;
  verifySsl: boolean;
  clientCert?: ExecutionClientCert;
  caCert?: ExecutionCaCert;
  clientCertificates: HostExecutionClientCert[];
  caCertificates: HostExecutionCaCert[];
  serverCipherOrder?: boolean;
  minTlsVersion?: MinTlsVersion;
  cipherSuites?: string;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  // Preserve the existing desktop default until the renderer completes its
  // first settings rehydration. Private addresses and metadata remain blocked
  // by the shared URL guard even when localhost is allowed.
  allowLocalhost: true,
  allowPrivateIPs: false,
  proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
  defaultTimeout: 30_000,
  verifySsl: true,
  clientCertificates: [],
  caCertificates: [],
};

let policy: ExecutionPolicy = clonePolicy(DEFAULT_EXECUTION_POLICY);

function clonePolicy(value: ExecutionPolicy): ExecutionPolicy {
  return structuredClone(value);
}

/** Returns a defensive copy; callers cannot mutate the process-wide policy. */
export function getExecutionPolicy(): ExecutionPolicy {
  return clonePolicy(policy);
}

/**
 * Atomically replaces the policy after IPC validation. SecretRef handles are
 * deliberately copied as opaque values; only protocol adapters may resolve
 * them immediately before constructing their native wire options.
 */
export function setExecutionPolicy(next: ExecutionPolicy): void {
  policy = clonePolicy(next);
}

/** Compatibility selector for existing SSRF guards during the adapter rollout. */
export function getNetworkPolicy(): Pick<ExecutionPolicy, 'allowLocalhost' | 'allowPrivateIPs'> {
  const { allowLocalhost, allowPrivateIPs } = policy;
  return { allowLocalhost, allowPrivateIPs };
}

function shouldBypassProxy(url: string, bypassList: readonly string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return bypassList.some((pattern) => {
      const lower = pattern.toLowerCase();
      if (lower.startsWith('*')) {
        const suffix = lower.slice(1);
        return hostname.endsWith(suffix) || hostname === suffix.slice(1);
      }
      if (lower.includes('*')) {
        const expression =
          '^' + lower.replace(/[.+?^${}()|[\\]\\]/g, '\\$&').replace(/\\*/g, '.*') + '$';
        return new RegExp(expression).test(hostname);
      }
      return hostname === lower;
    });
  } catch {
    return false;
  }
}

export interface ResolvedExecutionPolicy extends Omit<
  ExecutionPolicy,
  'proxy' | 'clientCert' | 'caCert'
> {
  proxy?: ExecutionProxy;
  clientCert?: ExecutionClientCert;
  caCert?: ExecutionCaCert;
}

/**
 * Resolve selection precedence only. This does not resolve SecretValue handles
 * or open a connection; adapters consume this result and resolve handles in
 * the main process at their final wire-time operation.
 */
export function resolveExecutionPolicyForUrl(
  url: string,
  snapshot: ExecutionPolicy = policy
): ResolvedExecutionPolicy {
  const hostClientCert = selectCertForUrl(url, snapshot.clientCertificates);
  const hostCaCert = selectCertForUrl(url, snapshot.caCertificates);
  const {
    proxy: configuredProxy,
    clientCert: globalClientCert,
    caCert: globalCaCert,
    ...base
  } = snapshot;

  return {
    ...structuredClone(base),
    proxy:
      configuredProxy.enabled && !shouldBypassProxy(url, configuredProxy.bypassList)
        ? structuredClone(configuredProxy)
        : undefined,
    clientCert: hostClientCert
      ? structuredClone(hostClientCert.cert)
      : structuredClone(globalClientCert),
    caCert: hostCaCert ? { pem: hostCaCert.pem } : structuredClone(globalCaCert),
  };
}

export function registerExecutionPolicyIPC(): void {
  ipcMain.handle(
    IPC.security.setExecutionPolicy,
    createValidatedHandler(IPC.security.setExecutionPolicy, ExecutionPolicySchema, (next) => {
      setExecutionPolicy(next);
      return { ok: true };
    })
  );
}
