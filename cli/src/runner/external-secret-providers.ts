import { AzureCliCredential, WorkloadIdentityCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { fromIni, fromTokenFile } from '@aws-sdk/credential-providers';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import {
  createExternalSecretResolver,
  ExternalSecretError,
  type ExternalSecretProvider,
  type ExternalSecretReference,
} from '@shared/secrets/external-secret-resolver';
import type { ExternalSecretProfile } from '@shared/secrets/external-secret-profile';

export type { ExternalSecretProfile } from '@shared/secrets/external-secret-profile';

function profileFor(
  reference: ExternalSecretReference,
  profiles: readonly ExternalSecretProfile[]
): ExternalSecretProfile {
  const profile = profiles.find((candidate) => candidate.id === reference.profileId);
  if (!profile || profile.provider !== reference.provider)
    throw new ExternalSecretError('profile-unavailable', reference.provider, reference.label);
  return profile;
}

function googleVersionName(
  profile: Extract<ExternalSecretProfile, { provider: 'google-secret-manager' }>,
  reference: ExternalSecretReference
): string {
  if (reference.secretId.includes('/') || !/^[A-Za-z0-9_-]+$/.test(reference.secretId))
    throw new ExternalSecretError('not-found', reference.provider, reference.label);
  return `projects/${profile.projectId}/secrets/${reference.secretId}/versions/${reference.selector ?? 'latest'}`;
}

/** Creates official-SDK provider adapters. No default credential chain or custom endpoint is used. */
export function createSdkExternalSecretResolver(profiles: readonly ExternalSecretProfile[]) {
  const providers: ExternalSecretProvider[] = [
    {
      provider: 'aws-secrets-manager',
      async resolve(reference, options) {
        const profile = profileFor(reference, profiles) as Extract<
          ExternalSecretProfile,
          { provider: 'aws-secrets-manager' }
        >;
        const credentials =
          profile.auth.kind === 'named-profile'
            ? fromIni({ profile: profile.auth.profile })
            : fromTokenFile({
                roleArn: profile.auth.roleArn,
                webIdentityTokenFile: profile.auth.tokenFile,
                ...(profile.auth.sessionName ? { roleSessionName: profile.auth.sessionName } : {}),
              });
        const client = new SecretsManagerClient({ region: profile.region, credentials });
        try {
          const response = await client.send(
            new GetSecretValueCommand({
              SecretId: reference.secretId,
              ...(reference.selector ? { VersionStage: reference.selector } : {}),
            }),
            { abortSignal: options?.signal }
          );
          if (typeof response.SecretString !== 'string' || response.SecretString.length === 0)
            throw new ExternalSecretError('not-found', reference.provider, reference.label);
          return response.SecretString;
        } finally {
          client.destroy();
        }
      },
    },
    {
      provider: 'google-secret-manager',
      async resolve(reference) {
        const profile = profileFor(reference, profiles) as Extract<
          ExternalSecretProfile,
          { provider: 'google-secret-manager' }
        >;
        const client = new SecretManagerServiceClient({
          keyFilename: profile.auth.credentialConfigFile,
        });
        try {
          const [response] = await client.accessSecretVersion({
            name: googleVersionName(profile, reference),
          });
          const data = response.payload?.data;
          const value = data ? Buffer.from(data).toString('utf8') : '';
          if (!value)
            throw new ExternalSecretError('not-found', reference.provider, reference.label);
          return value;
        } finally {
          await client.close();
        }
      },
    },
    {
      provider: 'azure-key-vault',
      async resolve(reference) {
        const profile = profileFor(reference, profiles) as Extract<
          ExternalSecretProfile,
          { provider: 'azure-key-vault' }
        >;
        const credential =
          profile.auth.kind === 'named-profile'
            ? new AzureCliCredential(
                profile.auth.subscription ? { subscription: profile.auth.subscription } : undefined
              )
            : new WorkloadIdentityCredential({
                tenantId: profile.auth.tenantId,
                clientId: profile.auth.clientId,
                tokenFilePath: profile.auth.tokenFile,
              });
        const client = new SecretClient(`https://${profile.vaultName}.vault.azure.net`, credential);
        const secret = await client.getSecret(reference.secretId, { version: reference.selector });
        if (!secret.value)
          throw new ExternalSecretError('not-found', reference.provider, reference.label);
        return secret.value;
      },
    },
  ];
  return createExternalSecretResolver(providers);
}
