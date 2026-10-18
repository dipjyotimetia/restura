import type { KafkaConnectConfig } from '../../ipc/ipc-validators';
import {
  type BrokerTlsOptions,
  resolveKafkaExecutionPolicy,
} from '../../security/broker-execution-policy';

/** Shared client options for the connection's Producer, Consumer and Admin clients. */
export interface KafkaClientOptions {
  clientId: string;
  bootstrapBrokers: string[];
  sasl?: {
    mechanism: 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512' | 'OAUTHBEARER';
    username?: string;
    password?: string;
    token?: string;
    oauthBearerExtensions?: Record<string, string>;
  };
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
    opts.sasl =
      cfg.auth.sasl.mechanism === 'OAUTHBEARER'
        ? {
            mechanism: 'OAUTHBEARER',
            token: cfg.auth.sasl.token,
            ...(cfg.auth.sasl.extensions
              ? { oauthBearerExtensions: cfg.auth.sasl.extensions }
              : {}),
          }
        : {
            mechanism: cfg.auth.sasl.mechanism,
            username: cfg.auth.sasl.username,
            password: cfg.auth.sasl.password,
          };
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
