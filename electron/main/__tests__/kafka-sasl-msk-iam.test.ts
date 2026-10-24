import { describe, expect, it, vi } from 'vitest';
import {
  createMskIamTokenProvider,
  generateMskIamToken,
  MSK_IAM_TOKEN_TTL_SECONDS,
  MSK_IAM_USER_AGENT,
} from '../handlers/kafka/sasl-msk-iam';

const FIXED_NOW = Date.UTC(2026, 9, 18, 12, 0, 0); // 2026-10-18T12:00:00Z
const CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

function decode(token: string): URL {
  // MSK IAM tokens are unpadded base64url of the presigned URL.
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  return new URL(Buffer.from(token, 'base64url').toString('utf8'));
}

describe('generateMskIamToken', () => {
  it('produces a SigV4-presigned kafka-cluster:Connect URL with the expected shape', async () => {
    const { value, expiresAt } = await generateMskIamToken('us-east-1', CREDS, FIXED_NOW);
    const url = decode(value);

    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('kafka.us-east-1.amazonaws.com');
    expect(url.pathname).toBe('/');
    const q = url.searchParams;
    expect(q.get('Action')).toBe('kafka-cluster:Connect');
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20261018/us-east-1/kafka-cluster/aws4_request'
    );
    expect(q.get('X-Amz-Date')).toBe('20261018T120000Z');
    expect(q.get('X-Amz-Expires')).toBe(String(MSK_IAM_TOKEN_TTL_SECONDS));
    expect(q.get('X-Amz-SignedHeaders')).toBe('host');
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(q.get('X-Amz-Security-Token')).toBeNull();
    // User-Agent is appended after signing (matches the official AWS signers).
    expect(q.get('User-Agent')).toBe(MSK_IAM_USER_AGENT);
    expect(expiresAt).toBe(FIXED_NOW + MSK_IAM_TOKEN_TTL_SECONDS * 1000);
  });

  it('is deterministic for a fixed clock + credentials and changes with the secret', async () => {
    const a = await generateMskIamToken('eu-west-1', CREDS, FIXED_NOW);
    const b = await generateMskIamToken('eu-west-1', CREDS, FIXED_NOW);
    const c = await generateMskIamToken(
      'eu-west-1',
      { ...CREDS, secretAccessKey: 'different' },
      FIXED_NOW
    );
    expect(a.value).toBe(b.value);
    expect(decode(c.value).searchParams.get('X-Amz-Signature')).not.toBe(
      decode(a.value).searchParams.get('X-Amz-Signature')
    );
  });

  it('includes the session token for temporary credentials', async () => {
    const { value } = await generateMskIamToken(
      'ap-southeast-2',
      { ...CREDS, sessionToken: 'FwoGZXIvYXdzEXAMPLE+/=' },
      FIXED_NOW
    );
    const q = decode(value).searchParams;
    expect(q.get('X-Amz-Security-Token')).toBe('FwoGZXIvYXdzEXAMPLE+/=');
    expect(decode(value).host).toBe('kafka.ap-southeast-2.amazonaws.com');
  });
});

describe('MSK IAM token expiry with temporary credentials', () => {
  it('caps expiresAt at the credential expiration minus the refresh skew', async () => {
    const expiration = new Date(FIXED_NOW + 5 * 60_000);
    const { expiresAt } = await generateMskIamToken(
      'us-east-1',
      { ...CREDS, expiration },
      FIXED_NOW
    );
    expect(expiresAt).toBe(expiration.getTime() - 30_000);
    const later = new Date(FIXED_NOW + 60 * 60_000);
    const capped = await generateMskIamToken(
      'us-east-1',
      { ...CREDS, expiration: later },
      FIXED_NOW
    );
    expect(capped.expiresAt).toBe(FIXED_NOW + MSK_IAM_TOKEN_TTL_SECONDS * 1000);
  });

  it('re-signs with fresh credentials before short-lived credentials expire', async () => {
    let now = FIXED_NOW;
    let generation = 0;
    const loadCredentials = vi.fn(async () => ({
      ...CREDS,
      secretAccessKey: `secret-${++generation}`,
      expiration: new Date(now + 120_000),
    }));
    const provider = createMskIamTokenProvider('us-east-1', loadCredentials, () => now);
    const first = await provider();
    // expiresAt = now + 90s → lead 30s → refresh at 60s.
    now += 59_000;
    expect(await provider()).toBe(first);
    now += 1_000;
    expect(await provider()).not.toBe(first);
    expect(loadCredentials).toHaveBeenCalledTimes(2);
  });
});

describe('createMskIamTokenProvider', () => {
  it('re-signs once less than 25% of the 15-minute lifetime remains', async () => {
    let now = FIXED_NOW;
    const loadCredentials = vi.fn(async () => CREDS);
    const provider = createMskIamTokenProvider('us-east-1', loadCredentials, () => now);
    const first = await provider();
    // 900s lifetime → refresh lead 225s → re-sign at 675s.
    now += 674_000;
    expect(await provider()).toBe(first);
    now = FIXED_NOW + 675_000;
    const refreshed = await provider();
    expect(refreshed).not.toBe(first);
    expect(loadCredentials).toHaveBeenCalledTimes(2);
  });
});
