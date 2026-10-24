import type * as KafkaLib from '@platformatic/kafka';
import type { KafkaConnectConfig } from '../../ipc/ipc-validators';
import {
  type BrokerTlsOptions,
  resolveKafkaExecutionPolicy,
} from '../../security/broker-execution-policy';
import { buildKafkaSaslOptions } from './sasl';

/** Shared client options for the connection's Producer, Consumer and Admin clients. */
export interface KafkaClientOptions {
  clientId: string;
  bootstrapBrokers: string[];
  sasl?: KafkaLib.SASLOptions;
  tls?: BrokerTlsOptions;
  connectTimeout?: number;
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

  const explicitTls = useTls && 'tls' in cfg.auth ? cfg.auth.tls : undefined;
  const policyConfig = resolveKafkaExecutionPolicy({
    bootstrapBrokers: cfg.bootstrapBrokers,
    usesTls: useTls,
    ...(explicitTls ? { tls: explicitTls } : {}),
  });
  opts.connectTimeout = policyConfig.connectTimeout;
  if (policyConfig.tls) opts.tls = policyConfig.tls;

  return opts;
}
