import { describe, expect, it } from 'vitest';
import { materializeExternalProtocolAuth } from '../security/external-secret-materializer';

describe('materializeExternalProtocolAuth', () => {
  it('fails closed before wire signing when a desktop external profile is unavailable', async () => {
    await expect(materializeExternalProtocolAuth({
      type: 'aws-signature',
      awsSignature: {
        accessKey: 'AKIA',
        secretKey: { kind: 'external', provider: 'aws-secrets-manager', profileId: 'missing', secretId: 'token', label: 'Token' },
        region: 'ap-southeast-2', service: 'execute-api',
      },
    })).rejects.toThrow('AWS Secrets Manager profile is unavailable.');
  });
});
