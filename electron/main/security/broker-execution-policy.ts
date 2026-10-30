import { selectCertForUrl } from '@shared/protocol/cert-matcher';
import { assertExecutionPolicyReady, getExecutionPolicy } from './execution-policy';
import { isProxyBypassed } from './proxy-bypass';
import { unwrapSecretValueMain } from './secret-handle-store';
import { buildTlsClientMaterial } from './tls-material';

export interface BrokerTlsOptions {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  pfx?: Buffer;
  rejectUnauthorized?: boolean;
  minVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  ciphers?: string;
  honorCipherOrder?: boolean;
}

interface MqttPolicyInput {
  brokerUrl: string;
  connectTimeout?: number;
  tls?: BrokerTlsOptions;
}

interface KafkaPolicyInput {
  bootstrapBrokers: readonly string[];
  usesTls: boolean;
  connectTimeout?: number;
  tls?: BrokerTlsOptions;
}

function getActiveProxy(url: URL) {
  const proxy = getExecutionPolicy().proxy;
  if (!proxy.enabled || proxy.type === 'none' || !proxy.host) return undefined;
  if (isProxyBypassed(url.hostname, proxy.bypassList)) return undefined;
  return proxy;
}

function selectedTls(url: URL, explicit?: BrokerTlsOptions): BrokerTlsOptions {
  const policy = getExecutionPolicy();
  const hostClientCert = selectCertForUrl(url, policy.certificates.clientCertificates);
  const hostCaCert = selectCertForUrl(url, policy.certificates.caCertificates);
  const material = buildTlsClientMaterial({
    clientCert: hostClientCert?.cert ?? policy.certificates.clientCert,
    caCert: hostCaCert ? { pem: hostCaCert.pem } : policy.certificates.caCert,
  }) as BrokerTlsOptions;

  const tls: BrokerTlsOptions = {
    ...material,
    rejectUnauthorized: policy.tls.verifySsl,
    ...(policy.tls.serverCipherOrder ? { honorCipherOrder: true } : {}),
    ...(policy.tls.minTlsVersion ? { minVersion: policy.tls.minTlsVersion } : {}),
    ...(policy.tls.cipherSuites ? { ciphers: policy.tls.cipherSuites } : {}),
    ...explicit,
  };

  // A connection-specific PEM certificate replaces a global PFX. Passing both
  // leaves Node's selection ambiguous and violates field-level override semantics.
  if (explicit?.cert !== undefined || explicit?.key !== undefined) delete tls.pfx;
  return tls;
}

function socksProxyUrl(proxy: NonNullable<ReturnType<typeof getActiveProxy>>): string {
  const username = proxy.auth?.username;
  const password = proxy.auth ? unwrapSecretValueMain(proxy.auth.password) : undefined;
  const credentials =
    username || password
      ? `${encodeURIComponent(username ?? '')}:${encodeURIComponent(password ?? '')}@`
      : '';
  // MQTT.js' `socks5://` and `socks4://` forms resolve a hostname locally.
  // Delegate target resolution to the configured proxy instead: it avoids a
  // direct local DNS dependency and keeps `*.localhost` echo targets portable.
  const protocol =
    proxy.type === 'socks5' ? 'socks5h' : proxy.type === 'socks4' ? 'socks4a' : proxy.type;
  return `${protocol}://${credentials}${proxy.host}:${proxy.port}`;
}

/**
 * Folds acknowledged global policy into a native MQTT connection. MQTT.js has
 * first-class SOCKS support for its raw TCP/TLS transports; HTTP-family proxy
 * configurations — and any proxy for the WebSocket transports (`ws:`/`wss:`),
 * which dial through a DNS-pinned `ws` socket — fail closed until a
 * CONNECT-capable adapter is available.
 */
export function resolveMqttExecutionPolicy<T extends MqttPolicyInput>(
  config: T
): T & { connectTimeout: number; tls?: BrokerTlsOptions; socksProxy?: string } {
  assertExecutionPolicyReady();
  const url = new URL(config.brokerUrl);
  const isWebSocket = url.protocol === 'ws:' || url.protocol === 'wss:';
  const proxy = getActiveProxy(url);
  if (proxy && (isWebSocket || (proxy.type !== 'socks4' && proxy.type !== 'socks5'))) {
    throw new Error(
      `MQTT client cannot honor the configured ${proxy.type.toUpperCase()} proxy for ${
        isWebSocket ? 'WebSocket' : 'raw'
      } broker connections`
    );
  }

  const usesTls = url.protocol === 'mqtts:' || url.protocol === 'wss:';
  return {
    ...config,
    connectTimeout: config.connectTimeout ?? getExecutionPolicy().timeout,
    ...(usesTls ? { tls: selectedTls(url, config.tls) } : {}),
    ...(proxy ? { socksProxy: socksProxyUrl(proxy) } : {}),
  };
}

/** Stable comparison key for resolved TLS material (Buffers compared by content). */
function tlsFingerprint(tls: BrokerTlsOptions): string {
  return JSON.stringify(
    Object.entries(tls)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('base64') : v])
  );
}

/**
 * Folds acknowledged global policy into a native Kafka connection. The current
 * Kafka client has no socket/proxy injection hook, so an active proxy for ANY
 * bootstrap broker is a hard error rather than a direct-connection bypass. The
 * client also takes a single TLS context for every broker, so bootstrap
 * brokers whose host-matched certificates differ are rejected rather than
 * silently dialled with the first broker's material.
 */
export function resolveKafkaExecutionPolicy<T extends KafkaPolicyInput>(
  config: T
): T & { connectTimeout: number; tls?: BrokerTlsOptions } {
  assertExecutionPolicyReady();
  if (config.bootstrapBrokers.length === 0) {
    throw new Error('Kafka connection requires at least one bootstrap broker');
  }
  let tls: BrokerTlsOptions | undefined;
  let tlsKey: string | undefined;
  for (const broker of config.bootstrapBrokers) {
    const url = new URL(`kafka://${broker}`);
    const proxy = getActiveProxy(url);
    if (proxy) {
      throw new Error(
        `Kafka client cannot honor the configured ${proxy.type.toUpperCase()} proxy for broker ${broker}`
      );
    }
    if (!config.usesTls) continue;
    const brokerTls = selectedTls(url, config.tls);
    const key = tlsFingerprint(brokerTls);
    if (tls === undefined) {
      tls = brokerTls;
      tlsKey = key;
    } else if (key !== tlsKey) {
      throw new Error(
        `Kafka bootstrap brokers resolve to different TLS certificates (${config.bootstrapBrokers[0]} vs ${broker}); the Kafka client uses one TLS context for every broker — split them into separate connections`
      );
    }
  }

  return {
    ...config,
    connectTimeout: config.connectTimeout ?? getExecutionPolicy().timeout,
    ...(tls ? { tls } : {}),
  };
}

/**
 * Folds acknowledged global policy into a Confluent Schema Registry HTTP(S)
 * client. HTTPS registries get the same host-selected TLS material as broker
 * connections (custom CA, mTLS client cert, verify toggle, cipher/min-version).
 * Like the Kafka brokers it serves, the registry client has no proxy hook, so
 * an active proxy for the registry host fails closed instead of bypassing it.
 */
export function resolveSchemaRegistryExecutionPolicy(registryUrl: string): {
  timeout: number;
  tls?: BrokerTlsOptions;
} {
  assertExecutionPolicyReady();
  const url = new URL(registryUrl);
  const proxy = getActiveProxy(url);
  if (proxy) {
    throw new Error(
      `Schema Registry client cannot honor the configured ${proxy.type.toUpperCase()} proxy`
    );
  }
  return {
    timeout: getExecutionPolicy().timeout,
    ...(url.protocol === 'https:' ? { tls: selectedTls(url) } : {}),
  };
}
