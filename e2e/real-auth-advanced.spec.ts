import { test, expect } from './fixtures/servers';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { TEST_AUTH_FIXTURES } from './mocks/authRoutes';
import { basicAuthHeader } from './utils/serverHelpers';

/**
 * End-to-end coverage for every authentication type Restura supports
 * (`AuthType` in src/types/index.ts):
 *
 *   - basic          (covered in real-http-advanced.spec.ts)
 *   - bearer         (covered in real-http-advanced.spec.ts)
 *   - api-key        (header + query)
 *   - oauth2         (client_credentials, password, authorization_code+PKCE,
 *                     refresh_token, device_code)
 *   - digest         (RFC 7616 with MD5)
 *   - aws-signature  (SigV4 verification)
 *
 * Plus discovery (.well-known/openid-configuration), JWKS, introspection,
 * userinfo, and JWT validation on protected endpoints.
 */

const { client: CLIENT, user: USER, aws: AWS } = TEST_AUTH_FIXTURES;

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

test.describe('Auth — API key', () => {
  test('header api key: missing → 401, correct → 200', async ({ servers }) => {
    const path = `${servers.http.url}/api-key/header/X-Api-Key/k-secret`;
    const noKey = await fetch(path);
    expect(noKey.status).toBe(401);
    const ok = await fetch(path, { headers: { 'x-api-key': 'k-secret' } });
    expect(ok.ok).toBe(true);
    const json = (await ok.json()) as { authenticated: boolean; via: string };
    expect(json).toEqual({ authenticated: true, via: 'header', key: 'X-Api-Key' });
  });

  test('query api key: missing → 401, correct → 200', async ({ servers }) => {
    const noKey = await fetch(`${servers.http.url}/api-key/query/api_key/q-secret`);
    expect(noKey.status).toBe(401);
    const ok = await fetch(`${servers.http.url}/api-key/query/api_key/q-secret?api_key=q-secret`);
    expect(ok.ok).toBe(true);
  });

  test('rejects wrong header value', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/api-key/header/X-Api-Key/k-secret`, {
      headers: { 'x-api-key': 'wrong' },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// OAuth 2.x — client_credentials
// ---------------------------------------------------------------------------

async function getToken(
  base: string,
  body: Record<string, string>,
  options: { clientAuth?: 'basic' | 'body' } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  let payload = body;
  if (options.clientAuth === 'basic') {
    headers.authorization = basicAuthHeader(CLIENT.id, CLIENT.secret);
  } else if (options.clientAuth === 'body') {
    payload = { ...body, client_id: CLIENT.id, client_secret: CLIENT.secret };
  }
  const form = new URLSearchParams(payload).toString();
  const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers, body: form });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test.describe('OAuth 2.x — client_credentials', () => {
  test('basic-auth client cred grant returns access_token + scope', async ({ servers }) => {
    const { status, json } = await getToken(
      servers.http.url,
      { grant_type: 'client_credentials', scope: 'read write' },
      { clientAuth: 'basic' }
    );
    expect(status).toBe(200);
    expect(json.token_type).toBe('Bearer');
    expect(json.scope).toBe('read write');
    expect(typeof json.access_token).toBe('string');
  });

  test('post-body client credentials also accepted', async ({ servers }) => {
    const { status, json } = await getToken(
      servers.http.url,
      { grant_type: 'client_credentials', scope: 'read' },
      { clientAuth: 'body' }
    );
    expect(status).toBe(200);
    expect(json.access_token).toBeDefined();
  });

  test('wrong client secret → 401 invalid_client', async ({ servers }) => {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    headers.authorization = basicAuthHeader(CLIENT.id, "nope");
    const res = await fetch(`${servers.http.url}/oauth/token`, {
      method: 'POST',
      headers,
      body: 'grant_type=client_credentials',
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_client');
  });
});

// ---------------------------------------------------------------------------
// OAuth 2.x — password grant
// ---------------------------------------------------------------------------

test.describe('OAuth 2.x — password grant', () => {
  test('correct username + password mints access + refresh tokens', async ({ servers }) => {
    const { status, json } = await getToken(
      servers.http.url,
      {
        grant_type: 'password',
        username: USER.username,
        password: USER.password,
        scope: 'read',
      },
      { clientAuth: 'basic' }
    );
    expect(status).toBe(200);
    expect(typeof json.access_token).toBe('string');
    expect(typeof json.refresh_token).toBe('string');
  });

  test('wrong user creds → 400 invalid_grant', async ({ servers }) => {
    const { status, json } = await getToken(
      servers.http.url,
      { grant_type: 'password', username: 'alice', password: 'nope' },
      { clientAuth: 'basic' }
    );
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_grant');
  });
});

// ---------------------------------------------------------------------------
// OAuth 2.x — authorization_code + PKCE (S256)
// ---------------------------------------------------------------------------

test.describe('OAuth 2.x — authorization_code + PKCE', () => {
  test('full flow: authorize → callback → token exchange yields access + id token', async ({ servers }) => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const stateParam = randomBytes(8).toString('hex');

    const authorizeUrl = new URL(`${servers.http.url}/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      client_id: CLIENT.id,
      response_type: 'code',
      redirect_uri: 'http://localhost/cb',
      scope: 'read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: stateParam,
    }).toString();

    const authorizeRes = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    expect(authorizeRes.status).toBe(302);
    const location = authorizeRes.headers.get('location') ?? '';
    const cb = new URL(location);
    expect(cb.searchParams.get('state')).toBe(stateParam);
    const code = cb.searchParams.get('code') ?? '';
    expect(code.length).toBeGreaterThan(0);

    const tokenRes = await getToken(
      servers.http.url,
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'http://localhost/cb',
        client_id: CLIENT.id,
      }
    );
    expect(tokenRes.status).toBe(200);
    expect(typeof tokenRes.json.access_token).toBe('string');
    expect(typeof tokenRes.json.id_token).toBe('string');
    expect(typeof tokenRes.json.refresh_token).toBe('string');
  });

  test('missing PKCE challenge at /authorize is rejected', async ({ servers }) => {
    const url = new URL(`${servers.http.url}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: CLIENT.id,
      response_type: 'code',
      redirect_uri: 'http://localhost/cb',
    }).toString();
    const res = await fetch(url.toString(), { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  test('PKCE verifier mismatch on /token returns invalid_grant', async ({ servers }) => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(`${servers.http.url}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: CLIENT.id,
      response_type: 'code',
      redirect_uri: 'http://localhost/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    const authorizeRes = await fetch(url.toString(), { redirect: 'manual' });
    const code = new URL(authorizeRes.headers.get('location')!).searchParams.get('code')!;

    const { status, json } = await getToken(servers.http.url, {
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong-verifier',
      redirect_uri: 'http://localhost/cb',
      client_id: CLIENT.id,
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_grant');
  });
});

// ---------------------------------------------------------------------------
// OAuth 2.x — refresh_token rotation
// ---------------------------------------------------------------------------

test.describe('OAuth 2.x — refresh_token', () => {
  test('refresh rotates access + refresh tokens; old access token is invalidated', async ({ servers }) => {
    const initial = await getToken(
      servers.http.url,
      { grant_type: 'password', username: USER.username, password: USER.password },
      { clientAuth: 'basic' }
    );
    expect(initial.status).toBe(200);
    const oldAccess = initial.json.access_token as string;
    const oldRefresh = initial.json.refresh_token as string;

    const refreshed = await getToken(
      servers.http.url,
      { grant_type: 'refresh_token', refresh_token: oldRefresh },
      { clientAuth: 'basic' }
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.access_token).not.toBe(oldAccess);

    const oldTokenCheck = await fetch(`${servers.http.url}/oauth/protected`, {
      headers: { authorization: `Bearer ${oldAccess}` },
    });
    expect(oldTokenCheck.status).toBe(401);

    const newTokenCheck = await fetch(`${servers.http.url}/oauth/protected`, {
      headers: { authorization: `Bearer ${refreshed.json.access_token}` },
    });
    expect(newTokenCheck.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OAuth 2.x — device code (RFC 8628)
// ---------------------------------------------------------------------------

test.describe('OAuth 2.x — device_code', () => {
  test('full device flow: device_authorization → pending → complete → token', async ({ servers }) => {
    const startRes = await fetch(`${servers.http.url}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT.id, scope: 'read' }).toString(),
    });
    const start = (await startRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
    };
    expect(typeof start.device_code).toBe('string');
    expect(start.user_code.length).toBeGreaterThan(0);

    const pending = await getToken(
      servers.http.url,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
      },
      { clientAuth: 'body' }
    );
    expect(pending.status).toBe(400);
    expect(pending.json.error).toBe('authorization_pending');

    const complete = await fetch(`${servers.http.url}/oauth/_test/complete-device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: start.user_code, action: 'authorize' }).toString(),
    });
    expect(complete.ok).toBe(true);

    const tok = await getToken(
      servers.http.url,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
      },
      { clientAuth: 'body' }
    );
    expect(tok.status).toBe(200);
    expect(typeof tok.json.access_token).toBe('string');
  });

  test('user denies → access_denied', async ({ servers }) => {
    const startRes = await fetch(`${servers.http.url}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT.id }).toString(),
    });
    const start = (await startRes.json()) as { device_code: string; user_code: string };
    await fetch(`${servers.http.url}/oauth/_test/complete-device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: start.user_code, action: 'deny' }).toString(),
    });
    const tok = await getToken(
      servers.http.url,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
      },
      { clientAuth: 'body' }
    );
    expect(tok.status).toBe(400);
    expect(tok.json.error).toBe('access_denied');
  });
});

// ---------------------------------------------------------------------------
// OAuth 2.x — discovery + introspection + userinfo
// ---------------------------------------------------------------------------

test.describe('OAuth 2.x — discovery & introspection', () => {
  test('.well-known/openid-configuration exposes the standard endpoints', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/.well-known/openid-configuration`);
    const json = (await res.json()) as {
      issuer: string;
      token_endpoint: string;
      authorization_endpoint: string;
      grant_types_supported: string[];
      code_challenge_methods_supported: string[];
    };
    expect(json.issuer).toBe('restura-mock');
    expect(json.token_endpoint).toContain('/oauth/token');
    expect(json.grant_types_supported).toContain('authorization_code');
    expect(json.code_challenge_methods_supported).toContain('S256');
  });

  test('JWKS exposes the signing key descriptor', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/.well-known/jwks.json`);
    const json = (await res.json()) as { keys: Array<{ alg: string; kid: string }> };
    expect(json.keys[0]?.alg).toBe('HS256');
    expect(json.keys[0]?.kid).toBe('restura-mock-1');
  });

  test('introspect surfaces an active token', async ({ servers }) => {
    const initial = await getToken(
      servers.http.url,
      { grant_type: 'client_credentials', scope: 'read' },
      { clientAuth: 'basic' }
    );
    const accessToken = initial.json.access_token as string;

    const introspected = await fetch(`${servers.http.url}/oauth/introspect`, {
      method: 'POST',
      headers: {
        authorization: basicAuthHeader(CLIENT.id, CLIENT.secret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });
    const json = (await introspected.json()) as {
      active: boolean;
      scope: string;
      client_id: string;
    };
    expect(json.active).toBe(true);
    expect(json.scope).toBe('read');
    expect(json.client_id).toBe(CLIENT.id);
  });

  test('introspect returns active:false for an unknown token', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/oauth/introspect`, {
      method: 'POST',
      headers: {
        authorization: basicAuthHeader(CLIENT.id, CLIENT.secret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: 'no-such-token' }).toString(),
    });
    const json = (await res.json()) as { active: boolean };
    expect(json.active).toBe(false);
  });

  test('userinfo returns sub/preferred_username from the JWT', async ({ servers }) => {
    const tok = await getToken(
      servers.http.url,
      { grant_type: 'password', username: USER.username, password: USER.password },
      { clientAuth: 'basic' }
    );
    const accessToken = tok.json.access_token as string;
    const res = await fetch(`${servers.http.url}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as { sub: string; preferred_username: string };
    expect(json.sub).toBe(USER.username);
    expect(json.preferred_username).toBe(USER.username);
  });

  test('protected resource rejects tampered JWT', async ({ servers }) => {
    const tok = await getToken(
      servers.http.url,
      { grant_type: 'client_credentials' },
      { clientAuth: 'basic' }
    );
    const tampered = (tok.json.access_token as string).slice(0, -4) + 'xxxx';
    const res = await fetch(`${servers.http.url}/oauth/protected`, {
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toBe('bad-signature');
  });
});

// ---------------------------------------------------------------------------
// Digest auth (RFC 7616)
// ---------------------------------------------------------------------------

test.describe('Auth — Digest (RFC 7616)', () => {
  test('challenge → 401 with WWW-Authenticate Digest, response → 200', async ({ servers }) => {
    const url = `${servers.http.url}/digest-auth/alice/secret`;
    const challengeRes = await fetch(url);
    expect(challengeRes.status).toBe(401);
    const challenge = challengeRes.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Digest');
    const realm = /realm="([^"]+)"/.exec(challenge)![1]!;
    const nonce = /nonce="([^"]+)"/.exec(challenge)![1]!;
    const qop = /qop="([^"]+)"/.exec(challenge)![1]!;
    const opaque = /opaque="([^"]+)"/.exec(challenge)?.[1] ?? '';
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const cnonce = randomBytes(8).toString('hex');
    const nc = '00000001';
    const ha1 = md5(`alice:${realm}:secret`);
    const ha2 = md5(`GET:/digest-auth/alice/secret`);
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    const auth = [
      `Digest username="alice"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="/digest-auth/alice/secret"`,
      `qop=${qop}`,
      `nc=${nc}`,
      `cnonce="${cnonce}"`,
      `response="${response}"`,
      `opaque="${opaque}"`,
    ].join(', ');
    const res = await fetch(url, { headers: { authorization: auth } });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { authenticated: boolean; user: string };
    expect(json).toEqual({ authenticated: true, user: 'alice' });
  });

  test('wrong digest response → 401', async ({ servers }) => {
    const auth = `Digest username="alice", realm="restura-mock", nonce="nope", uri="/digest-auth/alice/secret", response="${'0'.repeat(32)}"`;
    const res = await fetch(`${servers.http.url}/digest-auth/alice/secret`, {
      headers: { authorization: auth },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// AWS SigV4
// ---------------------------------------------------------------------------

function hmacBuf(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}
function awsSigningKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmacBuf(hmacBuf(hmacBuf(hmacBuf(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}

test.describe('Auth — AWS SigV4', () => {
  test('correctly signed GET passes verification', async ({ servers }) => {
    const { accessKey, secretKey, region, service } = AWS;
    const path = '/aws/protected';
    const url = `${servers.http.url}${path}`;
    const host = `127.0.0.1:${servers.http.port}`;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update('').digest('hex');
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = ['GET', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signingKey = awsSigningKey(secretKey, dateStamp, region, service);
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(url, {
      headers: {
        host,
        authorization: authHeader,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
      },
    });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { authenticated: boolean };
    expect(json.authenticated).toBe(true);
  });

  test('wrong secret → 401 signature mismatch', async ({ servers }) => {
    const { accessKey, region, service } = AWS;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=host;x-amz-date, Signature=${'0'.repeat(64)}`;
    const res = await fetch(`${servers.http.url}/aws/protected`, {
      headers: { authorization: authHeader, 'x-amz-date': amzDate, host: `127.0.0.1:${servers.http.port}` },
    });
    expect(res.status).toBe(401);
  });

  test('missing Authorization → 401', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/aws/protected`);
    expect(res.status).toBe(401);
  });
});
