import type * as KafkaLib from '@platformatic/kafka';
import type { KafkaConnectConfig } from '../../ipc/ipc-validators';
import {
  type BrokerTlsOptions,
  resolveKafkaExecutionPolicy,
} from '../../security/broker-execution-policy';
import { buildKafkaSaslOptions, plaintextKafkaSecret } from './sasl';

/** Shared client options for the connection's Producer, Consumer and Admin clients. */
export interface KafkaClientOptions {
  clientId: string;
  bootstrapBrokers: string[];
  sasl?: KafkaLib.SASLOptions;
  tls?: BrokerTlsOptions;
  connectTimeout?: number;
}

type KafkaTlsConfig = NonNullable<Extract<KafkaConnectConfig['auth'], { tls?: unknown }>['tls']>;

/**
 * Connection TLS as Node options. Expects a payload already passed through
 * `resolveKafkaConnect` (files read, passphrase handle resolved); a
 * leftover path or handle fails rather than silently connecting without it.
 */
function explicitTlsOptions(tls: KafkaTlsConfig): BrokerTlsOptions {
  if (
    (tls.caPath && tls.ca === undefined) ||
    (tls.certPath && tls.cert === undefined) ||
    (tls.keyPath && tls.key === undefined)
  ) {
    throw new Error('Kafka TLS files were not loaded');
  }
  return {
    ...(tls.ca !== undefined ? { ca: tls.ca } : {}),
    ...(tls.cert !== undefined ? { cert: tls.cert } : {}),
    ...(tls.key !== undefined ? { key: tls.key } : {}),
    ...(tls.passphrase !== undefined && tls.passphrase !== ''
      ? { passphrase: plaintextKafkaSecret(tls.passphrase) }
      : {}),
    ...(tls.rejectUnauthorized !== undefined ? { rejectUnauthorized: tls.rejectUnauthorized } : {}),
  };
}

export function buildClientOptions(cfg: KafkaConnectConfig): KafkaClientOptions {
  const opts: KafkaClientOptions = {
    clientId: cfg.clientId,
    bootstrapBrokers: cfg.bootstrapBrokers,
  };

  const useTls = cfg.auth.securityProtocol === 'SSL' || cfg.auth.securityProtocol === 'SASL_SSL';

  if (cfg.auth.securityProtocol !== 'PLAINTEXT' && 'sasl' in cfg.auth && cfg.auth.sasl) {
    opts.sasl = buildKafkaSaslOptions(cfg.auth.sasl);
  }

  const explicitTls =
    useTls && 'tls' in cfg.auth && cfg.auth.tls ? explicitTlsOptions(cfg.auth.tls) : undefined;
  const policyConfig = resolveKafkaExecutionPolicy({
    bootstrapBrokers: cfg.bootstrapBrokers,
    usesTls: useTls,
    ...(explicitTls ? { tls: explicitTls } : {}),
  });
  opts.connectTimeout = policyConfig.connectTimeout;
  if (policyConfig.tls) opts.tls = policyConfig.tls;

  return opts;
}
