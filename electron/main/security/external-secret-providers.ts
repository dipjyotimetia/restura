import { AzureCliCredential, WorkloadIdentityCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { fromIni, fromTokenFile } from '@aws-sdk/credential-providers';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import {
  createExternalSecretResolver,
  ExternalSecretError,
  type ExternalSecretReference,
  type ExternalSecretResolver,
} from '@shared/secrets/external-secret-resolver';

export type DesktopExternalSecretProfile =
  | { id: string; provider: 'aws-secrets-manager'; region: string; auth: { kind: 'named-profile'; profile: string } | { kind: 'workload-identity'; roleArn: string; tokenFile: string; sessionName?: string } }
  | { id: string; provider: 'google-secret-manager'; projectId: string; auth: { kind: 'named-profile' | 'workload-identity'; credentialConfigFile: string } }
  | { id: string; provider: 'azure-key-vault'; vaultName: string; auth: { kind: 'named-profile'; subscription?: string } | { kind: 'workload-identity'; tenantId: string; clientId: string; tokenFile: string } };

let profiles: DesktopExternalSecretProfile[] = [];
export function replaceExternalSecretProfiles(next: readonly DesktopExternalSecretProfile[]): void { profiles = [...next]; }
function profileFor(ref: ExternalSecretReference): DesktopExternalSecretProfile {
  const profile = profiles.find((candidate) => candidate.id === ref.profileId && candidate.provider === ref.provider);
  if (!profile) throw new ExternalSecretError('profile-unavailable', ref.provider, ref.label);
  return profile;
}

/** Main-process-only official-SDK resolver. It deliberately has no custom endpoints or default chain. */
export const desktopExternalSecretResolver: ExternalSecretResolver = createExternalSecretResolver([
  { provider: 'aws-secrets-manager', async resolve(ref, options) {
    const p = profileFor(ref) as Extract<DesktopExternalSecretProfile, { provider: 'aws-secrets-manager' }>;
    const credentials = p.auth.kind === 'named-profile' ? fromIni({ profile: p.auth.profile }) : fromTokenFile({ roleArn: p.auth.roleArn, webIdentityTokenFile: p.auth.tokenFile, ...(p.auth.sessionName ? { roleSessionName: p.auth.sessionName } : {}) });
    const client = new SecretsManagerClient({ region: p.region, credentials });
    try { const result = await client.send(new GetSecretValueCommand({ SecretId: ref.secretId, ...(ref.selector ? { VersionStage: ref.selector } : {}) }), { abortSignal: options?.signal }); if (!result.SecretString) throw new ExternalSecretError('not-found', ref.provider, ref.label); return result.SecretString; } finally { client.destroy(); }
  } },
  { provider: 'google-secret-manager', async resolve(ref) {
    const p = profileFor(ref) as Extract<DesktopExternalSecretProfile, { provider: 'google-secret-manager' }>;
    if (!/^[A-Za-z0-9_-]+$/.test(ref.secretId)) throw new ExternalSecretError('not-found', ref.provider, ref.label);
    const client = new SecretManagerServiceClient({ keyFilename: p.auth.credentialConfigFile });
    try { const [result] = await client.accessSecretVersion({ name: `projects/${p.projectId}/secrets/${ref.secretId}/versions/${ref.selector ?? 'latest'}` }); const value = result.payload?.data ? Buffer.from(result.payload.data).toString('utf8') : ''; if (!value) throw new ExternalSecretError('not-found', ref.provider, ref.label); return value; } finally { await client.close(); }
  } },
  { provider: 'azure-key-vault', async resolve(ref) {
    const p = profileFor(ref) as Extract<DesktopExternalSecretProfile, { provider: 'azure-key-vault' }>;
    const credential = p.auth.kind === 'named-profile' ? new AzureCliCredential(p.auth.subscription ? { subscription: p.auth.subscription } : undefined) : new WorkloadIdentityCredential({ tenantId: p.auth.tenantId, clientId: p.auth.clientId, tokenFilePath: p.auth.tokenFile });
    const result = await new SecretClient(`https://${p.vaultName}.vault.azure.net`, credential).getSecret(ref.secretId, { version: ref.selector });
    if (!result.value) throw new ExternalSecretError('not-found', ref.provider, ref.label); return result.value;
  } },
]);
