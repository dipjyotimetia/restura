import {
  createExternalSecretResolver,
  type ExternalSecretProvider,
} from '@shared/secrets/external-secret-resolver';
import { describe, expect, it } from 'vitest';
import { materializeExternalSecretsInAuth } from '../external-secret-materializer';

const provider: ExternalSecretProvider = {
  provider: 'azure-key-vault',
  resolve: async () => 'resolved-from-vault',
};

describe('materializeExternalSecretsInAuth', () => {
  it('resolves an external bearer token immediately before the CLI execution path', async () => {
    const auth = await materializeExternalSecretsInAuth(
      {
        type: 'bearer',
        bearer: {
          token: {
            kind: 'external',
            provider: 'azure-key-vault',
            profileId: 'prod',
            secretId: 'api-token',
            label: 'API token',
          },
        },
      },
      createExternalSecretResolver([provider])
    );
    expect(auth?.bearer?.token).toBe('resolved-from-vault');
  });

  it('fails closed when the CLI has no explicit external-secret resolver', async () => {
    await expect(
      materializeExternalSecretsInAuth(
        {
          type: 'bearer',
          bearer: {
            token: {
              kind: 'external',
              provider: 'azure-key-vault',
              profileId: 'prod',
              secretId: 'api-token',
            },
          },
        },
        undefined
      )
    ).rejects.toThrow('Configure an explicit external-secret profile');
  });
});
