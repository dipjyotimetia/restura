import { signSigV4 } from '@shared/protocol/auth-signer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smithyAwsRequestSigner } from '../security/aws-sigv4-smithy';

describe('Bedrock SigV4 parity: built-in signer vs @smithy/signature-v4 (#1044)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('produces the same signature for a model id path containing ":"', async () => {
    const request = {
      method: 'POST',
      url: 'https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-x-v1%3A0/converse',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{"messages":[]}',
    };
    const credentials = {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      sessionToken: 'session-token',
      region: 'eu-west-1',
      service: 'bedrock',
    };
    const smithy = await smithyAwsRequestSigner(request, credentials);
    const builtIn = await signSigV4(request, {
      accessKey: credentials.accessKeyId,
      secretKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region: credentials.region,
      service: credentials.service,
      doubleEncodePath: true,
    });
    const signature = (headers: Record<string, string>) =>
      /Signature=([0-9a-f]+)/.exec(
        Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? ''
      )?.[1];
    expect(signature(builtIn)).toBeDefined();
    expect(signature(builtIn)).toBe(signature(smithy));
  });
});
