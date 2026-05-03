// AWS Signature Version 4 signing — pure Web Crypto implementation

interface SigningConfig {
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface SignedHeaders {
  Authorization: string;
  'x-amz-date': string;
  'x-amz-content-sha256': string;
}

async function sha256Hex(data: string): Promise<string> {
  const buf = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const importedKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', importedKey, new TextEncoder().encode(data));
}

async function deriveSigningKey(
  secretKey: string,
  date: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode(`AWS4${secretKey}`).buffer as ArrayBuffer, date);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signRequest(config: SigningConfig): Promise<SignedHeaders> {
  const parsedUrl = new URL(config.url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const bodyHash = await sha256Hex(config.body ?? '');

  // Build canonical headers (must be sorted, lowercase keys)
  const canonicalHeadersMap: Record<string, string> = {
    host: parsedUrl.hostname,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate,
  };

  // Include caller-supplied headers that matter for signing (skip auth headers)
  const skipHeaders = new Set(['authorization', 'content-length', 'user-agent', 'accept-encoding']);
  for (const [k, v] of Object.entries(config.headers)) {
    const lk = k.toLowerCase();
    if (!skipHeaders.has(lk) && !canonicalHeadersMap[lk]) {
      canonicalHeadersMap[lk] = v.trim();
    }
  }

  const sortedHeaderKeys = Object.keys(canonicalHeadersMap).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${canonicalHeadersMap[k]}`).join('\n') + '\n';
  const signedHeaders = sortedHeaderKeys.join(';');

  // Build canonical query string (sorted by key)
  const queryParams = Array.from(parsedUrl.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalRequest = [
    config.method.toUpperCase(),
    parsedUrl.pathname || '/',
    queryParams,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${config.region}/${config.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

  const signingKey = await deriveSigningKey(config.secretKey, dateStamp, config.region, config.service);
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = bufToHex(signatureBytes);

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': bodyHash,
  };
}
