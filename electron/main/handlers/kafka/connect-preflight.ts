import { type KafkaSecretField, kafkaBoundSecretHandleId } from '@shared/protocol/broker-secret-id';
import {
  isProtocolExternalSecret,
  isProtocolSecretHandle,
} from '@shared/protocol/secret-value-schema';
import type { ProtocolSecretValue } from '@shared/protocol/types';
import type { KafkaConnectConfig, KafkaTlsConfig } from '../../ipc/validators/kafka';
import { assertKafkaBrokerHostsResolveSafe } from '../../security/broker-dns-guard';
import { loadBrokerTlsFiles } from '../../security/broker-tls-files';
import { assertKafkaBrokersSafe, assertRegistryUrlSafe } from '../../security/kafka-broker-guard';
import type { BrokerSecurityPolicy } from '../../security/mqtt-broker-guard';
import { describeSecretHandle, unwrapSecretValueMain } from '../../security/secret-handle-store';
import { KAFKA_SECRET_SCOPE, MISSING_KAFKA_CREDENTIAL } from './sasl';

export { MISSING_KAFKA_CREDENTIAL };

/**
 * Transport guard for a connect: the string-level broker / registry SSRF
 * checks, then the DNS-time half (SEC-K1) — every A/AAAA record of every
 * bootstrap host against the same policy. Advertised brokers from cluster
 * metadata are not re-checked (ADR-0006 residual).
 */
export async function guardKafkaConnect(
  cfg: KafkaConnectConfig,
  policy: BrokerSecurityPolicy
): Promise<void> {
  assertKafkaBrokersSafe(cfg.bootstrapBrokers, policy);
  if (cfg.registry) assertRegistryUrlSafe(cfg.registry.url, policy);
  await assertKafkaBrokerHostsResolveSafe(cfg.bootstrapBrokers, policy);
}

/**
 * Main-side resolution of a Kafka connect payload (SEC-K3). The renderer sends
 * stored credentials as broker-secret handles and TLS material as file paths;
 * this turns them into plaintext / PEM right before the clients are built, so
 * neither ever transits the renderer.
 */

/**
 * Resolve one stored-credential field. A handle resolves only when it is the
 * one bound to THIS connection's field (deterministic id) or was stored with
 * the `kafka` scope, so a crafted payload cannot send another feature's secret
 * to a broker. An unresolvable handle is an explicit error, never `''`.
 */
export function resolveKafkaStoredSecret(
  connectionId: string,
  field: KafkaSecretField,
  value: ProtocolSecretValue
): string {
  if (isProtocolExternalSecret(value)) {
    throw new Error('External secret references are not supported for Kafka credentials.');
  }
  if (isProtocolSecretHandle(value)) {
    const description = describeSecretHandle(value.id);
    if (!description) throw new Error(MISSING_KAFKA_CREDENTIAL);
    const bound = value.id === kafkaBoundSecretHandleId(connectionId, field);
    if (!bound && description.scope !== KAFKA_SECRET_SCOPE) {
      throw new Error('This stored secret is not available to Kafka connections.');
    }
  }
  const plaintext = unwrapSecretValueMain(value);
  if (!plaintext) throw new Error(MISSING_KAFKA_CREDENTIAL);
  return plaintext;
}

async function resolveTls(connectionId: string, tls: KafkaTlsConfig): Promise<KafkaTlsConfig> {
  const loaded = await loadBrokerTlsFiles(tls);
  if (loaded.passphrase === undefined || loaded.passphrase === '') return loaded;
  return {
    ...loaded,
    passphrase: resolveKafkaStoredSecret(connectionId, 'tls-passphrase', loaded.passphrase),
  };
}

function resolveSasl(
  connectionId: string,
  sasl: Extract<KafkaConnectConfig['auth'], { sasl: unknown }>['sasl']
): typeof sasl {
  switch (sasl.mechanism) {
    case 'PLAIN':
    case 'SCRAM-SHA-256':
    case 'SCRAM-SHA-512':
      return {
        ...sasl,
        password: resolveKafkaStoredSecret(connectionId, 'sasl-password', sasl.password),
      };
    case 'OAUTHBEARER':
      if (sasl.mode === 'client-credentials') return sasl;
      return { ...sasl, token: resolveKafkaStoredSecret(connectionId, 'oauth-token', sasl.token) };
    default:
      // OAuth client secret / AWS keys keep their lazy, scope-checked resolution.
      return sasl;
  }
}

async function resolveAuth(
  connectionId: string,
  auth: KafkaConnectConfig['auth']
): Promise<KafkaConnectConfig['auth']> {
  switch (auth.securityProtocol) {
    case 'PLAINTEXT':
      return auth;
    case 'SASL_PLAINTEXT':
      return { ...auth, sasl: resolveSasl(connectionId, auth.sasl) };
    case 'SASL_SSL':
      return {
        ...auth,
        sasl: resolveSasl(connectionId, auth.sasl),
        ...(auth.tls ? { tls: await resolveTls(connectionId, auth.tls) } : {}),
      };
    case 'SSL':
      return { ...auth, tls: await resolveTls(connectionId, auth.tls) };
  }
}

function resolveRegistry(
  connectionId: string,
  registry: NonNullable<KafkaConnectConfig['registry']>
): NonNullable<KafkaConnectConfig['registry']> {
  const auth = registry.auth;
  if (!auth) return registry;
  if (auth.type === 'bearer') {
    // Only this connection's bound handle is resolved here; any other handle /
    // external ref keeps registry.ts's own scope-checked resolution.
    const token = auth.token;
    if (
      isProtocolSecretHandle(token) &&
      token.id === kafkaBoundSecretHandleId(connectionId, 'registry-token')
    ) {
      return {
        ...registry,
        auth: {
          type: 'bearer',
          token: resolveKafkaStoredSecret(connectionId, 'registry-token', token),
        },
      };
    }
    return registry;
  }
  if (auth.password === undefined || auth.password === '') return registry;
  return {
    ...registry,
    auth: {
      ...auth,
      password: resolveKafkaStoredSecret(connectionId, 'registry-password', auth.password),
    },
  };
}

/**
 * Resolve every stored credential handle and TLS file path in a validated
 * connect payload. Throws (never returns empty credentials) when a stored
 * secret is gone or a TLS file cannot be read.
 */
export async function resolveKafkaConnect(cfg: KafkaConnectConfig): Promise<KafkaConnectConfig> {
  return {
    ...cfg,
    auth: await resolveAuth(cfg.connectionId, cfg.auth),
    ...(cfg.registry ? { registry: resolveRegistry(cfg.connectionId, cfg.registry) } : {}),
  };
}
