import { describe, expect, it } from 'vitest';
import { canonicalSigV4HeaderValue, canonicalSigV4Uri, isS3SigningService } from './auth-signer';

// Vectors from AWS's aws-sig-v4-test-suite (public example credentials). The
// canonical request is assembled from the signer's own canonicalisation
// helpers, then signed with Web Crypto here, so a drift in path or header
// canonicalisation shows up as a wrong official signature.
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const AMZ_DATE = '20150830T123600Z';
const SCOPE = '20150830/us-east-1/service/aws4_request';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw',
    key instanceof Uint8Array ? key.slice() : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

/** Official suite requests are non-S3 (`service`), so the path is double-encoded. */
function canonicalRequest(rawPath: string, headers: Array<[string, string]>): string {
  const canonical = headers
    .map(([k, v]) => [k.toLowerCase(), canonicalSigV4HeaderValue(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return [
    'GET',
    canonicalSigV4Uri(rawPath, !isS3SigningService('service')),
    '',
    `${canonical.map(([k, v]) => `${k}:${v}`).join('\n')}\n`,
    canonical.map(([k]) => k).join(';'),
    EMPTY_SHA256,
  ].join('\n');
}

async function signature(creq: string): Promise<string> {
  const creqHash = hex(await crypto.subtle.digest('SHA-256', enc.encode(creq)));
  const sts = ['AWS4-HMAC-SHA256', AMZ_DATE, SCOPE, creqHash].join('\n');
  let key: ArrayBuffer = await hmac(enc.encode(`AWS4${SECRET_KEY}`), '20150830');
  for (const part of ['us-east-1', 'service', 'aws4_request']) key = await hmac(key, part);
  return hex(await hmac(key, sts));
}

const BASE_HEADERS: Array<[string, string]> = [
  ['Host', 'example.amazonaws.com'],
  ['X-Amz-Date', AMZ_DATE],
];

describe('SigV4 canonicalisation against aws-sig-v4-test-suite', () => {
  it('get-vanilla', async () => {
    expect(await signature(canonicalRequest('/', BASE_HEADERS))).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
  });

  it('get-relative-relative normalises to the vanilla request', async () => {
    const creq = canonicalRequest('/example1/example2/../..', BASE_HEADERS);
    expect(creq.split('\n')[1]).toBe('/');
    expect(await signature(creq)).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
  });

  it('get-slashes collapses redundant slashes', () => {
    expect(canonicalRequest('//example//', BASE_HEADERS).split('\n')[1]).toBe('/example/');
  });

  it('get-space encodes the space', () => {
    expect(canonicalRequest('/example space/', BASE_HEADERS).split('\n')[1]).toBe(
      '/example%20space/'
    );
  });

  it('get-header-value-trim collapses inner whitespace and trims', () => {
    const creq = canonicalRequest('/', [
      ...BASE_HEADERS,
      ['My-Header1', ' value1'],
      ['My-Header2', ' "a   b   c"'],
    ]);
    expect(creq).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'my-header1:value1',
        'my-header2:"a b c"',
        `x-amz-date:${AMZ_DATE}`,
        '',
        'host;my-header1;my-header2;x-amz-date',
        EMPTY_SHA256,
      ].join('\n')
    );
  });

  it('keeps an S3 path exactly as sent', () => {
    expect(isS3SigningService('s3')).toBe(true);
    expect(isS3SigningService('S3-Object-Lambda')).toBe(true);
    expect(isS3SigningService('execute-api')).toBe(false);
    expect(canonicalSigV4Uri('/a%20b//c/../d', false)).toBe('/a%20b//c/../d');
  });
});
