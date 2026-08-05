import {
  ExternalSecretError,
  createExternalSecretResolver,
  type ExternalSecretProvider,
} from '@shared/secrets/external-secret-resolver';
import { describe, expect, it } from 'vitest';
import { startMockExternalSecretServer } from '../../../tests/helpers/mock-external-secret-server';

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
      expect((error as Error).message).toBe(
        'AWS Secrets Manager could not resolve Payments token.'
      );
      expect((error as Error).message).not.toContain('resolved-value');
    }
  });

  it('observes rotation and redacts denial through a mocked provider server', async () => {
    const server = await startMockExternalSecretServer();
    const provider: ExternalSecretProvider = {
      provider: 'aws-secrets-manager',
      resolve: async (_reference, options) => {
        const response = await fetch(`${server.url}/v1/secret`, { signal: options?.signal });
        if (!response.ok) throw new Error(await response.text());
        return ((await response.json()) as { value: string }).value;
      },
    };
    try {
      const resolver = createExternalSecretResolver([provider]);
      await expect(resolver.resolve(awsReference)).resolves.toBe('initial-secret');
      server.rotate('rotated-secret');
      await expect(resolver.resolve(awsReference)).resolves.toBe('rotated-secret');
      server.deny();
      await expect(resolver.resolve(awsReference)).rejects.toThrow(
        'AWS Secrets Manager could not resolve Payments token.'
      );
    } finally {
      await server.close();
    }
  });

  it('returns a stable cancellation error when the mocked provider is slow', async () => {
    const server = await startMockExternalSecretServer();
    server.delay(1_000);
    const provider: ExternalSecretProvider = {
      provider: 'aws-secrets-manager',
      resolve: async (_reference, options) => {
        const response = await fetch(`${server.url}/v1/secret`, { signal: options?.signal });
        return ((await response.json()) as { value: string }).value;
      },
    };
    const controller = new AbortController();
    const resolving = createExternalSecretResolver([provider]).resolve(awsReference, {
      signal: controller.signal,
    });
    controller.abort();
    try {
      await expect(resolving).rejects.toMatchObject({ code: 'cancelled' });
    } finally {
      await server.close();
    }
  });
});
