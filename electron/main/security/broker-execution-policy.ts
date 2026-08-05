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
 * first-class SOCKS support; HTTP-family proxy configurations must fail closed
 * until a CONNECT-capable raw-socket adapter is available.
 */
export function resolveMqttExecutionPolicy<T extends MqttPolicyInput>(
  config: T
): T & { connectTimeout: number; tls?: BrokerTlsOptions; socksProxy?: string } {
  assertExecutionPolicyReady();
  const url = new URL(config.brokerUrl);
  const proxy = getActiveProxy(url);
  if (proxy && proxy.type !== 'socks4' && proxy.type !== 'socks5') {
    throw new Error(
      `MQTT client cannot honor the configured ${proxy.type.toUpperCase()} proxy for raw broker connections`
    );
  }

  return {
    ...config,
    connectTimeout: config.connectTimeout ?? getExecutionPolicy().timeout,
    ...(url.protocol === 'mqtts:' ? { tls: selectedTls(url, config.tls) } : {}),
    ...(proxy ? { socksProxy: socksProxyUrl(proxy) } : {}),
  };
}

/**
 * Folds acknowledged global policy into a native Kafka connection. The current
 * Kafka client has no socket/proxy injection hook, so an active proxy is a
 * hard error rather than a direct-connection bypass.
 */
export function resolveKafkaExecutionPolicy<T extends KafkaPolicyInput>(
  config: T
): T & { connectTimeout: number; tls?: BrokerTlsOptions } {
  assertExecutionPolicyReady();
  const firstBroker = config.bootstrapBrokers[0];
  if (!firstBroker) throw new Error('Kafka connection requires at least one bootstrap broker');
  const url = new URL(`kafka://${firstBroker}`);
  const proxy = getActiveProxy(url);
  if (proxy) {
    throw new Error(
      `Kafka client cannot honor the configured ${proxy.type.toUpperCase()} proxy for broker connections`
    );
  }

  return {
    ...config,
    connectTimeout: config.connectTimeout ?? getExecutionPolicy().timeout,
    ...(config.usesTls ? { tls: selectedTls(url, config.tls) } : {}),
  };
}
