import {
  ExternalSecretError,
  createExternalSecretResolver,
  type ExternalSecretProvider,
} from '@shared/secrets/external-secret-resolver';
import { describe, expect, it } from 'vitest';

const awsReference = {
  kind: 'external' as const,
  provider: 'aws-secrets-manager' as const,
  profileId: 'engineering-prod',
  secretId: 'restura/payments/token',
  label: 'Payments token',
};

describe('createExternalSecretResolver', () => {
  it('routes a reference to its matching provider without exposing the value in errors', async () => {
    const provider: ExternalSecretProvider = {
      provider: 'aws-secrets-manager',
      resolve: async () => 'resolved-value',
    };

    await expect(createExternalSecretResolver([provider]).resolve(awsReference)).resolves.toBe(
      'resolved-value'
    );
  });

  it('fails closed when a provider is unavailable', async () => {
    try {
      await createExternalSecretResolver([]).resolve(awsReference);
      throw new Error('expected resolver to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalSecretError);
      expect((error as Error).message).toContain('AWS Secrets Manager');
      expect((error as Error).message).not.toContain(awsReference.secretId);
    }
  });

  it('redacts provider failures that echo a secret value', async () => {
    const provider: ExternalSecretProvider = {
      provider: 'aws-secrets-manager',
      resolve: async () => {
        throw new Error('Access denied for restura/payments/token: resolved-value');
      },
    };

    try {
      await createExternalSecretResolver([provider]).resolve(awsReference);
      throw new Error('expected resolver to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'provider-error' });
      expect((error as Error).message).toBe('AWS Secrets Manager could not resolve Payments token.');
      expect((error as Error).message).not.toContain('resolved-value');
    }
  });
});
