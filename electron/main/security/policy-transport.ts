import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { selectCertForUrl } from '@shared/protocol/cert-matcher';
import { applyManagedTransportPolicy, createEnterpriseProxyAgent } from './enterprise-network';
import { assertExecutionPolicyReady, getExecutionPolicy } from './execution-policy';
import {
  getManagedCaCertificateBundle,
  getManagedEnterprisePolicy,
} from './managed-enterprise-policy';
import { isProxyBypassed } from './proxy-bypass';
import { createPinnedFetch, type SafeAddress } from './safe-connect';
import { buildTlsClientMaterial } from './tls-material';

export interface PolicyTransportProxy {
  enabled: boolean;
  type: 'none' | 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  auth?: { username: string; password: unknown };
  integratedAuth?: true;
  resolution?: string;
}

export interface PolicyTransportConfig {
  url: string;
  timeout?: number;
  proxy?: PolicyTransportProxy;
  verifySsl?: boolean;
  clientCert?: { pfx?: string; cert?: string; key?: string; passphrase?: unknown };
  caCert?: { pem: string };
  serverCipherOrder?: boolean;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  cipherSuites?: string;
}

function proxyForUrl(url: URL): PolicyTransportProxy | undefined {
  const proxy = getExecutionPolicy().proxy;
  const bypassed = isProxyBypassed(url.hostname, proxy.bypassList);
  if (!proxy.enabled || proxy.type === 'none' || !proxy.host || bypassed) return undefined;
  return {
    enabled: true,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    ...(proxy.auth ? { auth: proxy.auth } : {}),
  };
}

/**
 * Applies the acknowledged desktop connection policy to an HTTP-derived
 * protocol. IPC-provided transport fields always remain deliberate overrides.
 */
export function resolvePolicyTransport<T extends PolicyTransportConfig>(
  config: T
): T & PolicyTransportConfig & Required<Pick<PolicyTransportConfig, 'timeout' | 'verifySsl'>> {
  assertExecutionPolicyReady();
  const policy = getExecutionPolicy();
  const managed = getManagedEnterprisePolicy();
  const url = new URL(config.url);
  const hostClientCert = selectCertForUrl(url, policy.certificates.clientCertificates);
  const hostCaCert = selectCertForUrl(url, policy.certificates.caCertificates);

  const resolved = {
    ...config,
    timeout: config.timeout ?? policy.timeout,
    proxy: managed.status.state === 'managed' ? config.proxy : (config.proxy ?? proxyForUrl(url)),
    verifySsl: config.verifySsl ?? policy.tls.verifySsl,
    clientCert: config.clientCert ?? hostClientCert?.cert ?? policy.certificates.clientCert,
    caCert: config.caCert ?? (hostCaCert ? { pem: hostCaCert.pem } : policy.certificates.caCert),
    serverCipherOrder: config.serverCipherOrder ?? policy.tls.serverCipherOrder,
    minTlsVersion: config.minTlsVersion ?? policy.tls.minTlsVersion,
    cipherSuites: config.cipherSuites ?? policy.tls.cipherSuites,
  };
  return applyManagedTransportPolicy(resolved, managed, getManagedCaCertificateBundle());
}

/**
 * The streaming adapters currently retain DNS-pinned fetches. They must never
 * quietly degrade a configured proxy into a direct connection.
 */
export function assertPinnedFetchCanHonorPolicy(config: PolicyTransportConfig): void {
  const managed = getManagedEnterprisePolicy().status.state === 'managed';
  if (
    config.proxy?.enabled &&
    config.proxy.type !== 'none' &&
    (!managed || (!['http', 'https'].includes(config.proxy.type) && !config.proxy.resolution))
  ) {
    throw new Error(
      `Configured ${config.proxy.type.toUpperCase()} proxy cannot be honored by this DNS-pinned connection`
    );
  }
}

async function requestBodyBuffer(body: BodyInit | null | undefined): Promise<Buffer | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(await new Response(body).arrayBuffer());
}

async function fetchThroughEnterpriseProxy(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  config: PolicyTransportConfig
): Promise<Response> {
  const url =
    typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  const managed = getManagedEnterprisePolicy();
  const agent = await createEnterpriseProxyAgent(config.proxy!, config, managed);
  const body = await requestBodyBuffer(init?.body);
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        agent,
        signal: init?.signal ?? undefined,
        rejectUnauthorized: config.verifySsl,
        ...buildTlsClientMaterial(config),
        ...(config.serverCipherOrder ? { honorCipherOrder: true } : {}),
        ...(config.minTlsVersion ? { minVersion: config.minTlsVersion } : {}),
        ...(config.cipherSuites ? { ciphers: config.cipherSuites } : {}),
      },
      (incoming) => {
        const headers = new Headers();
        for (const [header, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(header, item);
          } else if (value !== undefined) {
            headers.set(header, value);
          }
        }
        const noBody =
          init?.method === 'HEAD' ||
          incoming.statusCode === 204 ||
          incoming.statusCode === 205 ||
          incoming.statusCode === 304;
        const cleanup = () => agent.destroy();
        incoming.once('end', cleanup);
        incoming.once('close', cleanup);
        resolve(
          new Response(noBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers,
          })
        );
      }
    );
    request.once('error', (error) => {
      agent.destroy();
      reject(error);
    });
    if (body) request.end(body);
    else request.end();
  });
}

/** Build a direct, DNS-pinned fetch that still applies the resolved TLS policy. */
export function createPolicyPinnedFetch(
  config: PolicyTransportConfig,
  pinned?: SafeAddress
): typeof globalThis.fetch {
  assertPinnedFetchCanHonorPolicy(config);
  if (
    config.proxy?.enabled &&
    (['http', 'https'].includes(config.proxy.type) || config.proxy.resolution)
  ) {
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchThroughEnterpriseProxy(input, init, config)) as typeof globalThis.fetch;
  }
  if (!pinned) {
    throw new Error('A DNS-pinned address is required for a direct managed connection');
  }
  return createPinnedFetch(pinned.host, pinned.ip, {
    rejectUnauthorized: config.verifySsl,
    ...buildTlsClientMaterial(config),
    ...(config.serverCipherOrder ? { honorCipherOrder: true } : {}),
    ...(config.minTlsVersion ? { minVersion: config.minTlsVersion } : {}),
    ...(config.cipherSuites ? { ciphers: config.cipherSuites } : {}),
  });
}
