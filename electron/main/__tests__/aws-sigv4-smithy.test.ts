import { applyAuth } from '@shared/protocol/auth-signer';
import type { ProtocolAuthConfig } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';
import { smithySigV4Signer } from '../security/aws-sigv4-smithy';

// The AWS SigV4 example credentials (from the AWS docs test fixtures). These are
// public, non-secret example values.
const CREDS = {
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'execute-api',
};

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

describe('smithySigV4Signer', () => {
  it('produces a well-formed AWS4-HMAC-SHA256 Authorization header', async () => {
    const out = lower(
      await smithySigV4Signer(
        { method: 'GET', url: 'https://api.example.com/resource', headers: {}, body: undefined },
        CREDS
      )
    );
    expect(out['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/execute-api\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/
    );
    // host is always part of the signed set.
    expect(out['authorization']).toContain('SignedHeaders=host');
    expect(out['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(out['x-amz-content-sha256']).toBeTruthy();
  });

  it('signs the host WITH its port so the signature matches the wire Host header', async () => {
    const out = lower(
      await smithySigV4Signer(
        { method: 'GET', url: 'http://localhost:8080/aws/protected', headers: {}, body: undefined },
        CREDS
      )
    );
    expect(out['host']).toBe('localhost:8080');
  });

  it('hashes the request body into x-amz-content-sha256 (differs from an empty body)', async () => {
    const empty = lower(
      await smithySigV4Signer(
        { method: 'POST', url: 'https://api.example.com/x', headers: {}, body: undefined },
        CREDS
      )
    );
    const withBody = lower(
      await smithySigV4Signer(
        {
          method: 'POST',
          url: 'https://api.example.com/x',
          headers: {},
          body: JSON.stringify({ hello: 'world' }),
        },
        CREDS
      )
    );
    expect(withBody['x-amz-content-sha256']).not.toBe(empty['x-amz-content-sha256']);
  });

  it('signs a non-hashable body (FormData) as UNSIGNED-PAYLOAD', async () => {
    const fd = new FormData();
    fd.append('field', 'value');
    const out = lower(
      await smithySigV4Signer(
        {
          method: 'POST',
          url: 'https://api.example.com/upload',
          headers: {},
          body: fd as unknown as BodyInit,
        },
        CREDS
      )
    );
    expect(out['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(out['authorization']).toContain('SignedHeaders=host');
  });

  it('produces the SAME signature as the built-in Web-Crypto signer (web/desktop parity)', async () => {
    // Both implement SigV4, so for an identical request + clock they must agree.
    // This guards against the web (built-in) and desktop (@smithy) signers
    // drifting apart, and gives a deterministic byte-level check the round-trip
    // e2e (which uses a live clock) can't.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2015-08-30T12:36:00Z'));
    try {
      const auth: ProtocolAuthConfig = {
        type: 'aws-signature',
        awsSignature: {
          accessKey: CREDS.accessKey,
          secretKey: CREDS.secretKey,
          region: CREDS.region,
          service: CREDS.service,
        },
      };
      const args = {
        method: 'GET',
        url: 'https://example.amazonaws.com/path',
        headers: {} as Record<string, string>,
        body: undefined,
      };
      const builtin = lower((await applyAuth(auth, args)).headers);
      const smithy = lower(
        (await applyAuth(auth, { ...args, sigV4Signer: smithySigV4Signer })).headers
      );
      expect(smithy['authorization']).toBe(builtin['authorization']);
    } finally {
      vi.useRealTimers();
    }
  });
});
