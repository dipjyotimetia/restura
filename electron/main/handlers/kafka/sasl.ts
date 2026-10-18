import { fromIni } from '@aws-sdk/credential-providers';
import type * as KafkaLib from '@platformatic/kafka';
import { isProtocolExternalSecret } from '@shared/protocol/secret-value-schema';
import type { ProtocolSecretValue } from '@shared/protocol/types';
import { createLogger } from '@shared/runtime/logger';
import type { KafkaSaslConfig } from '../../ipc/validators/kafka';
import type { SmithySigV4Credentials } from '../../security/aws-sigv4-smithy';
import { desktopExternalSecretResolver } from '../../security/external-secret-providers';
import { unwrapSecretValueMain } from '../../security/secret-handle-store';
import { createGssapiAuthenticator, type KerberosModuleLike } from './sasl-gssapi';
import { createMskIamTokenProvider } from './sasl-msk-iam';
import { createClientCredentialsTokenProvider } from './sasl-oauth';

/**
 * Maps the validated Kafka SASL IPC config onto `@platformatic/kafka`'s
 * `SASLOptions` (#918). Secrets carried as SecretValue (handle / inline /
 * external) are resolved here, in main, lazily inside the credential
 * providers — the renderer never sees the plaintext for handles.
 */

const log = createLogger('kafka');

export interface KafkaSaslDeps {
  resolveSecret?: (value: ProtocolSecretValue) => Promise<string | undefined>;
  guardedFetch?: (url: string) => Promise<typeof globalThis.fetch>;
  loadProfileCredentials?: (profile: string) => Promise<SmithySigV4Credentials>;
  loadKerberos?: () => KerberosModuleLike;
  now?: () => number;
}

/** Resolve any SecretValue form to plaintext, main-process only. */
export async function resolveKafkaSecret(value: ProtocolSecretValue): Promise<string | undefined> {
  if (isProtocolExternalSecret(value)) return desktopExternalSecretResolver.resolve(value);
  return unwrapSecretValueMain(value);
}

async function loadAwsProfileCredentials(profile: string): Promise<SmithySigV4Credentials> {
  const creds = await fromIni({ profile })();
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
  };
}

type MskIamCredentialsConfig = Extract<
  KafkaSaslConfig,
  { mechanism: 'AWS_MSK_IAM' }
>['credentials'];

function mskCredentialsLoader(
  config: MskIamCredentialsConfig,
  deps: KafkaSaslDeps,
  resolveSecret: (value: ProtocolSecretValue) => Promise<string | undefined>
): () => Promise<SmithySigV4Credentials> {
  if (config.source === 'profile') {
    const load = deps.loadProfileCredentials ?? loadAwsProfileCredentials;
    return () => load(config.profile);
  }
  return async () => {
    const secretAccessKey = await resolveSecret(config.secretAccessKey);
    if (!secretAccessKey) {
      throw new Error('AWS secret access key for MSK IAM could not be resolved — re-enter it.');
    }
    const sessionToken = config.sessionToken ? await resolveSecret(config.sessionToken) : undefined;
    if (config.sessionToken && !sessionToken) {
      throw new Error('AWS session token for MSK IAM could not be resolved — re-enter it.');
    }
    return {
      accessKeyId: config.accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    };
  };
}

/**
 * The library wraps provider failures in a generic "provider threw an error"
 * AuthenticationError, so record the actionable reason (never a secret — only
 * our own error messages / the IdP's error description) in the main log.
 */
function withFailureLog(mechanism: string, provider: () => Promise<string>): () => Promise<string> {
  return () =>
    provider().catch((err: unknown) => {
      log.warn('sasl credential provider failed', {
        mechanism,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });
}

export function buildKafkaSaslOptions(
  sasl: KafkaSaslConfig,
  deps: KafkaSaslDeps = {}
): KafkaLib.SASLOptions {
  const resolveSecret = deps.resolveSecret ?? resolveKafkaSecret;
  switch (sasl.mechanism) {
    case 'PLAIN':
    case 'SCRAM-SHA-256':
    case 'SCRAM-SHA-512':
      return { mechanism: sasl.mechanism, username: sasl.username, password: sasl.password };
    case 'OAUTHBEARER': {
      const extensions = sasl.extensions ? { oauthBearerExtensions: sasl.extensions } : {};
      if (sasl.mode === 'client-credentials') {
        return {
          mechanism: 'OAUTHBEARER',
          token: withFailureLog(
            'OAUTHBEARER',
            createClientCredentialsTokenProvider(
              {
                tokenEndpoint: sasl.tokenEndpoint,
                clientId: sasl.clientId,
                clientSecret: sasl.clientSecret,
                scope: sasl.scope,
              },
              {
                resolveSecret,
                ...(deps.guardedFetch ? { guardedFetch: deps.guardedFetch } : {}),
                ...(deps.now ? { now: deps.now } : {}),
              }
            )
          ),
          ...extensions,
        };
      }
      return { mechanism: 'OAUTHBEARER', token: sasl.token, ...extensions };
    }
    case 'GSSAPI':
      return {
        mechanism: 'GSSAPI',
        authenticate: createGssapiAuthenticator(
          { serviceName: sasl.serviceName, principal: sasl.principal },
          deps.loadKerberos
        ),
      };
    case 'AWS_MSK_IAM':
      // MSK IAM rides on SASL/OAUTHBEARER with a SigV4-presigned token.
      return {
        mechanism: 'OAUTHBEARER',
        token: withFailureLog(
          'AWS_MSK_IAM',
          createMskIamTokenProvider(
            sasl.region,
            mskCredentialsLoader(sasl.credentials, deps, resolveSecret),
            deps.now
          )
        ),
      };
  }
}
