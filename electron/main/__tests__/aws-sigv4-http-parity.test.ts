import { Sha256 } from '@aws-crypto/sha256-js';
import { applyAuth, type SigV4Credentials, signSigV4 } from '@shared/protocol/auth-signer';
import type { ProtocolAuthConfig } from '@shared/protocol/types';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smithySigV4Signer } from '../security/aws-sigv4-smithy';

// Web / self-host / CLI sign HTTP SigV4 with the shared Web-Crypto signer;
// desktop signs with `@smithy/signature-v4`. For one request and one clock they
// must produce the same signature, and both must follow the AWS rule: every
// service but S3 normalises the path and URI-encodes it again; S3 encodes once
// and keeps the path as-is.

// Public AWS documentation example credentials (aws-sig-v4-test-suite).
const CREDS = {
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};

function signatureOf(headers: Record<string, string>): string | undefined {
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  return /Signature=([0-9a-f]{64})/.exec(auth ?? '')?.[1];
}

function signedHeadersOf(headers: Record<string, string>): string | undefined {
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  return /SignedHeaders=([^,]+)/.exec(auth ?? '')?.[1];
}

/** Independent reference: stock smithy, told explicitly how to treat the path. */
async function referenceSignature(
  rawUrl: string,
  service: string,
  headers: Record<string, string>,
  options: { uriEscapePath: boolean; path?: string }
): Promise<string | undefined> {
  const url = new URL(rawUrl);
  const signer = new SignatureV4({
    credentials: { accessKeyId: CREDS.accessKey, secretAccessKey: CREDS.secretKey },
    region: CREDS.region,
    service,
    sha256: Sha256,
    uriEscapePath: options.uriEscapePath,
  });
  const signed = await signer.sign(
    new HttpRequest({
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      path: options.path ?? url.pathname,
      query: {},
      headers: { ...headers, host: url.host },
    })
  );
  return signatureOf(signed.headers as Record<string, string>);
}

describe('HTTP AWS SigV4: shared signer and desktop smithy signer agree', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2015-08-30T12:36:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const cases: Array<[string, string, string, Record<string, string>]> = [
    ['an already-encoded path segment', 'execute-api', 'https://h.example.com/a%20b', {}],
    ['a path with a space', 'execute-api', 'https://h.example.com/a b/c', {}],
    ['redundant slashes and a dot-dot', 'execute-api', 'https://h.example.com/a//b/../c', {}],
    ['a model id containing ":"', 'bedrock', 'https://h.example.com/model/x-v1:0/converse', {}],
    ['an S3 key with a space', 's3', 'https://bucket.s3.amazonaws.com/my key.txt', {}],
    ['an S3 key with an encoded char', 's3', 'https://bucket.s3.amazonaws.com/a%20b', {}],
    ['an S3 key with double slashes', 's3', 'https://bucket.s3.amazonaws.com/a//b/c', {}],
    ['an S3 key with a sub-delim', 's3', "https://bucket.s3.amazonaws.com/it's!.txt", {}],
    ['an S3 Object Lambda path', 's3-object-lambda', 'https://h.example.com/a b', {}],
    [
      'a header with inner runs of spaces',
      'execute-api',
      'https://h.example.com/p',
      {
        'X-Custom': '  a   b\tc  ',
      },
    ],
    [
      'a header that smithy never signs',
      'execute-api',
      'https://h.example.com/p',
      {
        'Cache-Control': 'no-cache',
        'X-Amzn-Trace-Id': 'Root=1',
      },
    ],
  ];

  it.each(cases)('agree for %s', async (_label, service, url, headers) => {
    const creds: SigV4Credentials = { ...CREDS, service };
    const args = { method: 'GET', url, headers, body: undefined };
    const shared = await signSigV4(args, creds);
    const desktop = await smithySigV4Signer(args, creds);
    expect(signatureOf(shared)).toMatch(/^[0-9a-f]{64}$/);
    expect(signedHeadersOf(desktop)).toBe(signedHeadersOf(shared));
    expect(signatureOf(desktop)).toBe(signatureOf(shared));
  });

  it('agree through applyAuth (the path every harness takes)', async () => {
    const auth: ProtocolAuthConfig = {
      type: 'aws-signature',
      awsSignature: { ...CREDS, service: 'execute-api' },
    };
    const args = {
      method: 'GET',
      url: 'https://h.example.com/a%20b//c',
      headers: { 'X-Custom': 'a   b' },
      body: undefined,
    };
    const web = await applyAuth(auth, args);
    const desktop = await applyAuth(auth, { ...args, sigV4Signer: smithySigV4Signer });
    expect(signatureOf(desktop.headers)).toBe(signatureOf(web.headers));
  });

  it('double-encodes and normalises the path for a non-S3 service (stock smithy rule)', async () => {
    const url = 'https://h.example.com/a%20b//x/../c';
    const expected = await referenceSignature(url, 'execute-api', {}, { uriEscapePath: true });
    const shared = await signSigV4(
      { method: 'GET', url, headers: {}, body: undefined },
      { ...CREDS, service: 'execute-api' }
    );
    expect(signatureOf(shared)).toBe(expected);
  });

  it('encodes an S3 key once and keeps empty segments', async () => {
    const url = 'https://bucket.s3.amazonaws.com/a%20b//c';
    const expected = await referenceSignature(url, 's3', {}, { uriEscapePath: false });
    const shared = await signSigV4(
      { method: 'GET', url, headers: {}, body: undefined },
      { ...CREDS, service: 's3' }
    );
    expect(signatureOf(shared)).toBe(expected);
  });
});
