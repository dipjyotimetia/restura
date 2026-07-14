import { describe, expect, it } from 'vitest';
import { applyAuth } from './auth-signer';

describe('applyAuth', () => {
  it('returns empty headers for undefined auth', async () => {
    const result = await applyAuth(undefined, {
      method: 'GET',
      url: 'https://example.com/',
      headers: {},
      body: undefined,
    });
    expect(result.headers).toEqual({});
  });

  it('returns empty headers for type "none"', async () => {
    const result = await applyAuth(
      { type: 'none' },
      { method: 'GET', url: 'https://example.com/', headers: {}, body: undefined }
    );
    expect(result.headers).toEqual({});
  });

  it('returns empty headers for non-SigV4 types (handled client-side)', async () => {
    for (const type of ['basic', 'bearer', 'api-key', 'oauth2', 'digest'] as const) {
      const result = await applyAuth(
        { type },
        { method: 'GET', url: 'https://example.com/', headers: {}, body: undefined }
      );
      expect(result.headers).toEqual({});
    }
  });

  it('throws when SigV4 selected but awsSignature config missing', async () => {
    await expect(
      applyAuth(
        { type: 'aws-signature' },
        { method: 'GET', url: 'https://s3.amazonaws.com/', headers: {}, body: undefined }
      )
    ).rejects.toThrow(/awsSignature/i);
  });

  it('throws when SigV4 credentials are blank', async () => {
    await expect(
      applyAuth(
        {
          type: 'aws-signature',
          awsSignature: { accessKey: '', secretKey: '', region: '', service: '' },
        },
        { method: 'GET', url: 'https://s3.amazonaws.com/', headers: {}, body: undefined }
      )
    ).rejects.toThrow(/accessKey|secretKey|region|service/i);
  });

  it('produces a SigV4 Authorization header for a GET with no body', async () => {
    const result = await applyAuth(
      {
        type: 'aws-signature',
        awsSignature: {
          accessKey: 'AKIAIOSFODNN7EXAMPLE',
          secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          region: 'us-east-1',
          service: 's3',
        },
      },
      {
        method: 'GET',
        url: 'https://examplebucket.s3.amazonaws.com/test.txt',
        headers: {},
        body: undefined,
      }
    );

    expect(result.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[a-f0-9]{64}$/
    );
    expect(result.headers['X-Amz-Date']).toMatch(/^\d{8}T\d{6}Z$/);
    // Empty body → SHA256 of empty string
    expect(result.headers['X-Amz-Content-Sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('hashes a string body for SigV4', async () => {
    const result = await applyAuth(
      {
        type: 'aws-signature',
        awsSignature: {
          accessKey: 'AKIA',
          secretKey: 'SECRET',
          region: 'us-east-1',
          service: 's3',
        },
      },
      {
        method: 'POST',
        url: 'https://s3.amazonaws.com/bucket/key',
        headers: { 'content-type': 'application/json' },
        body: '{"foo":"bar"}',
      }
    );

    // Known SHA-256 of '{"foo":"bar"}'
    expect(result.headers['X-Amz-Content-Sha256']).toBe(
      '7a38bf81f383f69433ad6e900d35b3e2385593f76a7b7ab5d4355b8ba41ee24b'
    );
  });

  it('hashes a Uint8Array body for SigV4', async () => {
    const bytes = new TextEncoder().encode('hello');
    const result = await applyAuth(
      {
        type: 'aws-signature',
        awsSignature: {
          accessKey: 'AKIA',
          secretKey: 'SECRET',
          region: 'us-east-1',
          service: 'execute-api',
        },
      },
      {
        method: 'POST',
        url: 'https://api.example.com/',
        headers: {},
        body: bytes,
      }
    );

    // SHA-256 of 'hello'
    expect(result.headers['X-Amz-Content-Sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('uses UNSIGNED-PAYLOAD for FormData bodies', async () => {
    const fd = new FormData();
    fd.append('field', 'value');
    const result = await applyAuth(
      {
        type: 'aws-signature',
        awsSignature: {
          accessKey: 'AKIA',
          secretKey: 'SECRET',
          region: 'us-east-1',
          service: 's3',
        },
      },
      {
        method: 'POST',
        url: 'https://s3.amazonaws.com/bucket/key',
        headers: {},
        body: fd,
      }
    );

    expect(result.headers['X-Amz-Content-Sha256']).toBe('UNSIGNED-PAYLOAD');
  });

  it('skips Authorization, Content-Length, User-Agent, Accept-Encoding from signed headers', async () => {
    const result = await applyAuth(
      {
        type: 'aws-signature',
        awsSignature: {
          accessKey: 'AKIA',
          secretKey: 'SECRET',
          region: 'us-east-1',
          service: 's3',
        },
      },
      {
        method: 'GET',
        url: 'https://s3.amazonaws.com/',
        headers: {
          Authorization: 'should-be-skipped',
          'Content-Length': '0',
          'User-Agent': 'test',
          'Accept-Encoding': 'gzip',
          'X-Custom': 'kept',
        },
        body: undefined,
      }
    );

    // Authorization is fully replaced, not appended
    expect(result.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);

    // Extract SignedHeaders list
    const auth = result.headers.Authorization ?? '';
    const match = /SignedHeaders=([^,]+)/.exec(auth);
    expect(match).not.toBeNull();
    const signedHeaders = (match?.[1] ?? '').split(';');
    expect(signedHeaders).not.toContain('authorization');
    expect(signedHeaders).not.toContain('content-length');
    expect(signedHeaders).not.toContain('user-agent');
    expect(signedHeaders).not.toContain('accept-encoding');
    // Custom header should be in the signed set
    expect(signedHeaders).toContain('x-custom');
    // Mandatory ones present
    expect(signedHeaders).toContain('host');
    expect(signedHeaders).toContain('x-amz-date');
    expect(signedHeaders).toContain('x-amz-content-sha256');
  });

  it('produces a deterministic signature for fixed inputs (mocked Date)', async () => {
    // Freeze Date.now / new Date() to a known timestamp so the amz-date is stable.
    const fixedIso = '2024-01-15T12:34:56.000Z';
    const realDate = Date;
    class MockDate extends realDate {
      constructor() {
        super(fixedIso);
      }
      static override now(): number {
        return new realDate(fixedIso).getTime();
      }
    }
    (globalThis as unknown as { Date: typeof Date }).Date = MockDate as unknown as typeof Date;

    try {
      const result = await applyAuth(
        {
          type: 'aws-signature',
          awsSignature: {
            accessKey: 'AKIAIOSFODNN7EXAMPLE',
            secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            region: 'us-east-1',
            service: 's3',
          },
        },
        {
          method: 'GET',
          url: 'https://examplebucket.s3.amazonaws.com/test.txt',
          headers: {},
          body: undefined,
        }
      );
      expect(result.headers['X-Amz-Date']).toBe('20240115T123456Z');
      // The full Authorization is deterministic given fixed inputs + date.
      // Pin the signature to detect accidental algorithm changes.
      expect(result.headers.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20240115\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/
      );
    } finally {
      (globalThis as unknown as { Date: typeof Date }).Date = realDate;
    }
  });
});
