import { createHash, createHmac, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { bearerToken, writeJson as json } from '../utils/serverHelpers';
import { verifyOAuth1 } from './oauth1Verify';

/**
 * In-memory mock of an OAuth 2.x authorization server, plus standalone
 * endpoints for API key, Digest auth (RFC 7616), JWT-protected resources,
 * and AWS SigV4 verification.
 *
 * Designed to be wired into the existing httpServer route table; it returns
 * `Route` objects compatible with that file's signatures.
 */

export interface AuthRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: string;
  match: RegExpExecArray | null;
}

export interface AuthRoute {
  method: string;
  test: string | RegExp;
  handle: (ctx: AuthRouteContext) => void | Promise<void>;
}

interface IssuedToken {
  accessToken: string;
  refreshToken: string;
  scope: string;
  user: string;
  expiresAt: number;
  clientId: string;
}

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
  scope: string;
  user: string;
  expiresAt: number;
}

interface DeviceAuth {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scope: string;
  status: 'pending' | 'authorized' | 'denied';
  user: string | null;
  expiresAt: number;
}

const HMAC_SECRET = 'restura-mock-jwt-secret';

/**
 * Test fixtures: the mock authorization server, OAuth client, and AWS
 * credentials. Exported so spec files use the same values rather than
 * redeclaring magic strings that would silently drift on rename.
 */
export const TEST_AUTH_FIXTURES = {
  client: { id: 'restura-client', secret: 'restura-secret' },
  user: { username: 'alice', password: 'wonderland' },
  /** Bearer token the `/bearer` route verifies (fail-closed — wrong token ⇒ 401). */
  bearer: { token: 'restura-bearer-token' },
  /** OAuth 1.0a credentials the `/oauth1/protected` route verifies (HMAC-SHA1). */
  oauth1: {
    consumerKey: 'restura-consumer-key',
    consumerSecret: 'restura-consumer-secret',
    accessToken: 'restura-access-token',
    accessTokenSecret: 'restura-access-token-secret',
  },
  aws: {
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'execute-api',
  },
} as const;

const { client: CLIENT, user: USER, aws: AWS, oauth1: OAUTH1 } = TEST_AUTH_FIXTURES;

interface AuthState {
  tokens: Map<string, IssuedToken>;
  codes: Map<string, AuthCode>;
  devices: Map<string, DeviceAuth>;
  /** Number of times any auth challenge was issued (across all flows). */
  challengeCount: number;
  /** Number of access tokens minted. */
  tokenIssueCount: number;
}

const state: AuthState = {
  tokens: new Map(),
  codes: new Map(),
  devices: new Map(),
  challengeCount: 0,
  tokenIssueCount: 0,
};

export function resetAuthState(): void {
  state.tokens.clear();
  state.codes.clear();
  state.devices.clear();
  state.challengeCount = 0;
  state.tokenIssueCount = 0;
}

/**
 * Cheap O(n) prune of expired tokens, codes, and device codes. n is bounded
 * by the test's request count, so this is sub-millisecond — but it keeps
 * the state from growing monotonically when reset() isn't called between
 * manual probes (e.g. when the dev server is left running).
 */
function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of state.tokens) if (v.expiresAt < now) state.tokens.delete(k);
  for (const [k, v] of state.codes) if (v.expiresAt < now) state.codes.delete(k);
  for (const [k, v] of state.devices) if (v.expiresAt < now) state.devices.delete(k);
}

export function authMetrics(): {
  challengeCount: number;
  tokenIssueCount: number;
  activeTokens: number;
} {
  return {
    challengeCount: state.challengeCount,
    tokenIssueCount: state.tokenIssueCount,
    activeTokens: state.tokens.size,
  };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function mainContentType(req: IncomingMessage): string {
  return String(req.headers['content-type'] ?? '')
    .split(';')[0]!
    .trim();
}

function parseTokenRequest(req: IncomingMessage, body: string): Record<string, string | undefined> {
  if (mainContentType(req) === 'application/json') {
    try {
      return (JSON.parse(body) ?? {}) as Record<string, string | undefined>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function basicCreds(req: IncomingMessage): { user: string; pass: string } | null {
  const m = /^Basic\s+(.+)$/.exec(String(req.headers.authorization ?? ''));
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
    const [user, ...rest] = decoded.split(':');
    return { user: user ?? '', pass: rest.join(':') };
  } catch {
    return null;
  }
}

function constantTimeEq(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// JWT (HS256)
// ---------------------------------------------------------------------------

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'restura-mock-1' }));
  const claims = b64url(JSON.stringify(payload));
  const signingInput = `${header}.${claims}`;
  const sig = createHmac('sha256', HMAC_SECRET).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

interface JwtVerifyResult {
  ok: boolean;
  reason?: 'malformed' | 'bad-signature' | 'expired';
  payload?: Record<string, unknown>;
}

function verifyJwt(token: string): JwtVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  const expected = b64url(createHmac('sha256', HMAC_SECRET).update(`${h}.${p}`).digest());
  if (!constantTimeEq(s, expected)) return { ok: false, reason: 'bad-signature' };
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof payload['exp'] === 'number' && payload['exp'] * 1000 < Date.now()) {
      return { ok: false, reason: 'expired', payload };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

// ---------------------------------------------------------------------------
// Token store helpers
// ---------------------------------------------------------------------------

function issueToken(opts: {
  user: string;
  scope: string;
  clientId: string;
  expiresInSec?: number;
}): IssuedToken {
  pruneExpired();
  const expiresInSec = opts.expiresInSec ?? 3600;
  const accessToken = signJwt({
    iss: 'restura-mock',
    sub: opts.user,
    aud: opts.clientId,
    scope: opts.scope,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    jti: randomUUID(),
  });
  const token: IssuedToken = {
    accessToken,
    refreshToken: randomBytes(24).toString('base64url'),
    scope: opts.scope,
    user: opts.user,
    expiresAt: Date.now() + expiresInSec * 1000,
    clientId: opts.clientId,
  };
  state.tokens.set(accessToken, token);
  state.tokenIssueCount += 1;
  return token;
}

function lookupTokenByRefresh(refreshToken: string): IssuedToken | null {
  for (const t of state.tokens.values()) {
    if (t.refreshToken === refreshToken) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// AWS SigV4 verification (subset)
// ---------------------------------------------------------------------------

function hexHash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function awsSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

interface SigV4Header {
  algorithm: string;
  credential: string;
  signedHeaders: string;
  signature: string;
}

function parseSigV4Header(header: string): SigV4Header | null {
  const m =
    /^(AWS4-HMAC-SHA256)\s+Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)/.exec(
      header
    );
  if (!m) return null;
  return { algorithm: m[1]!, credential: m[2]!, signedHeaders: m[3]!, signature: m[4]! };
}

function verifySigV4(req: IncomingMessage, body: string): { ok: boolean; reason?: string } {
  const auth = String(req.headers.authorization ?? '');
  const parsed = parseSigV4Header(auth);
  if (!parsed) return { ok: false, reason: 'missing or malformed Authorization header' };

  const [accessKey, dateStamp, region, service, suffix] = parsed.credential.split('/');
  if (!accessKey || !dateStamp || !region || !service || suffix !== 'aws4_request') {
    return { ok: false, reason: 'malformed Credential' };
  }
  if (accessKey !== AWS.accessKey) return { ok: false, reason: 'unknown access key' };
  if (region !== AWS.region) return { ok: false, reason: 'wrong region' };
  if (service !== AWS.service) return { ok: false, reason: 'wrong service' };

  const amzDate = String(req.headers['x-amz-date'] ?? '');
  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) return { ok: false, reason: 'missing/malformed x-amz-date' };

  const headerNames = parsed.signedHeaders.split(';');
  const canonicalHeaders =
    headerNames
      .map((name) => {
        const value = String(req.headers[name] ?? '')
          .trim()
          .replace(/\s+/g, ' ');
        return `${name}:${value}\n`;
      })
      .join('') || '\n';

  // Method + canonical URI + canonical query + headers + signed-headers + payload-hash
  const url = new URL(req.url ?? '/', 'http://localhost');
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const payloadHash = String(req.headers['x-amz-content-sha256'] ?? hexHash(body));
  const canonicalRequest = [
    req.method ?? 'GET',
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    parsed.signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hexHash(canonicalRequest),
  ].join('\n');
  const signingKey = awsSigningKey(AWS.secretKey, dateStamp, region, service);
  const expected = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  if (!constantTimeEq(parsed.signature, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Digest auth (RFC 7616, MD5)
// ---------------------------------------------------------------------------

function md5(data: string): string {
  return createHash('md5').update(data).digest('hex');
}

function parseDigest(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    out[m[1]!] = (m[2] ?? m[3] ?? '').trim();
  }
  return out;
}

function verifyDigest(req: IncomingMessage, expectedUser: string, expectedPass: string): boolean {
  const auth = String(req.headers.authorization ?? '');
  const m = /^Digest\s+(.+)$/.exec(auth);
  if (!m) return false;
  const params = parseDigest(m[1]!);
  if (params['username'] !== expectedUser) return false;
  if (!params['realm'] || !params['nonce'] || !params['response']) return false;
  const ha1 = md5(`${expectedUser}:${params['realm']}:${expectedPass}`);
  const ha2 = md5(`${req.method ?? 'GET'}:${params['uri']}`);
  let expected: string;
  if (params['qop'] === 'auth' && params['nc'] && params['cnonce']) {
    expected = md5(`${ha1}:${params['nonce']}:${params['nc']}:${params['cnonce']}:auth:${ha2}`);
  } else {
    expected = md5(`${ha1}:${params['nonce']}:${ha2}`);
  }
  return constantTimeEq(params['response'] ?? '', expected);
}

/** Parse `Key="value"` pairs out of an X-WSSE UsernameToken header value. */
function parseWsseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1]!] = m[2]!.replace(/\\(.)/g, '$1');
  }
  return out;
}

/**
 * Verify a WS-Security UsernameToken (WSSE) header against the wire format
 * produced by shared/protocol/wsse-header.ts — the one source of truth for the
 * client side. Supports both PasswordDigest (default) and PasswordText.
 *
 *   digest = base64( sha1( rawNonceBytes + created + password ) )
 *
 * The header's Nonce is base64; decode it to raw bytes before hashing (WSSE 1.1
 * §3.1) — matching `concatBytes(nonce, utf8(created), utf8(password))` on the
 * signer side.
 */
export function verifyWsse(
  req: IncomingMessage,
  expectedUser: string,
  expectedPass: string
): { ok: boolean; reason?: string } {
  const header = String(req.headers['x-wsse'] ?? '').trim();
  const m = /^UsernameToken\s+(.+)$/s.exec(header);
  if (!m) return { ok: false, reason: 'missing or malformed X-WSSE header' };

  const attrs = parseWsseAttrs(m[1]!);
  if (attrs['Username'] !== expectedUser) return { ok: false, reason: 'username mismatch' };

  // PasswordText form (verbatim password — discouraged outside TLS).
  if (attrs['PasswordText'] !== undefined) {
    return constantTimeEq(attrs['PasswordText'], expectedPass)
      ? { ok: true }
      : { ok: false, reason: 'password mismatch' };
  }

  const digest = attrs['PasswordDigest'];
  const nonce = attrs['Nonce'];
  const created = attrs['Created'];
  if (!digest || !nonce || created === undefined) {
    return { ok: false, reason: 'missing PasswordDigest/Nonce/Created' };
  }
  const expected = createHash('sha1')
    .update(
      Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created + expectedPass, 'utf8')])
    )
    .digest('base64');
  return constantTimeEq(digest, expected) ? { ok: true } : { ok: false, reason: 'digest mismatch' };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const TOKEN_TTL_SEC = 3600;

const tokenEndpoint: AuthRoute = {
  method: 'POST',
  test: '/oauth/token',
  handle: ({ req, res, body }) => {
    const params = parseTokenRequest(req, body);
    const headerCreds = basicCreds(req);
    const clientId = (headerCreds?.user ?? params['client_id'] ?? '').trim();
    const clientSecret = (headerCreds?.pass ?? params['client_secret'] ?? '').trim();

    const grant = params['grant_type'];
    // Public clients (PKCE) skip secret check.
    const isPublicClient =
      grant === 'authorization_code' && !clientSecret && !!params['code_verifier'];
    const credsOk = isPublicClient
      ? clientId === CLIENT.id
      : clientId === CLIENT.id && clientSecret === CLIENT.secret;

    if (!credsOk) {
      state.challengeCount += 1;
      json(res, 401, { error: 'invalid_client' });
      return;
    }

    if (grant === 'client_credentials') {
      const t = issueToken({
        user: 'service-account',
        scope: params['scope'] ?? 'read',
        clientId,
        expiresInSec: TOKEN_TTL_SEC,
      });
      json(res, 200, {
        access_token: t.accessToken,
        token_type: 'Bearer',
        expires_in: TOKEN_TTL_SEC,
        scope: t.scope,
      });
      return;
    }

    if (grant === 'password') {
      if (params['username'] !== USER.username || params['password'] !== USER.password) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      const t = issueToken({
        user: USER.username,
        scope: params['scope'] ?? 'read',
        clientId,
        expiresInSec: TOKEN_TTL_SEC,
      });
      json(res, 200, {
        access_token: t.accessToken,
        token_type: 'Bearer',
        expires_in: TOKEN_TTL_SEC,
        refresh_token: t.refreshToken,
        scope: t.scope,
      });
      return;
    }

    if (grant === 'authorization_code') {
      const code = state.codes.get(params['code'] ?? '');
      if (!code) {
        json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
        return;
      }
      if (code.expiresAt < Date.now()) {
        state.codes.delete(code.code);
        json(res, 400, { error: 'invalid_grant', error_description: 'code expired' });
        return;
      }
      if (
        code.redirectUri &&
        params['redirect_uri'] &&
        code.redirectUri !== params['redirect_uri']
      ) {
        json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      }
      // PKCE verification.
      const verifier = params['code_verifier'] ?? '';
      let challengeOk = false;
      if (code.codeChallengeMethod === 'plain') {
        challengeOk = verifier === code.codeChallenge;
      } else {
        const computed = createHash('sha256').update(verifier).digest('base64url');
        challengeOk = computed === code.codeChallenge;
      }
      if (!challengeOk) {
        json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verifier mismatch' });
        return;
      }
      state.codes.delete(code.code);
      const t = issueToken({
        user: code.user,
        scope: code.scope,
        clientId,
        expiresInSec: TOKEN_TTL_SEC,
      });
      json(res, 200, {
        access_token: t.accessToken,
        token_type: 'Bearer',
        expires_in: TOKEN_TTL_SEC,
        refresh_token: t.refreshToken,
        scope: t.scope,
        id_token: signJwt({
          iss: 'restura-mock',
          sub: code.user,
          aud: clientId,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC,
        }),
      });
      return;
    }

    if (grant === 'refresh_token') {
      const existing = lookupTokenByRefresh(params['refresh_token'] ?? '');
      if (!existing) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      // Rotate: invalidate the old token, issue a fresh one.
      state.tokens.delete(existing.accessToken);
      const t = issueToken({
        user: existing.user,
        scope: existing.scope,
        clientId,
        expiresInSec: TOKEN_TTL_SEC,
      });
      json(res, 200, {
        access_token: t.accessToken,
        token_type: 'Bearer',
        expires_in: TOKEN_TTL_SEC,
        refresh_token: t.refreshToken,
        scope: t.scope,
      });
      return;
    }

    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      const dc = state.devices.get(params['device_code'] ?? '');
      if (!dc) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      if (dc.status === 'pending') {
        json(res, 400, { error: 'authorization_pending' });
        return;
      }
      if (dc.status === 'denied') {
        state.devices.delete(dc.deviceCode);
        json(res, 400, { error: 'access_denied' });
        return;
      }
      state.devices.delete(dc.deviceCode);
      const t = issueToken({
        user: dc.user ?? USER.username,
        scope: dc.scope,
        clientId,
        expiresInSec: TOKEN_TTL_SEC,
      });
      json(res, 200, {
        access_token: t.accessToken,
        token_type: 'Bearer',
        expires_in: TOKEN_TTL_SEC,
        refresh_token: t.refreshToken,
        scope: t.scope,
      });
      return;
    }

    json(res, 400, { error: 'unsupported_grant_type', grant_type: grant ?? null });
  },
};

const authorizeEndpoint: AuthRoute = {
  method: 'GET',
  test: '/oauth/authorize',
  handle: ({ res, url }) => {
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const responseType = url.searchParams.get('response_type') ?? '';
    const codeChallenge = url.searchParams.get('code_challenge') ?? '';
    const codeChallengeMethod = (url.searchParams.get('code_challenge_method') ?? 'plain') as
      'S256' | 'plain';
    const scope = url.searchParams.get('scope') ?? 'read';
    const stateParam = url.searchParams.get('state') ?? '';

    if (clientId !== CLIENT.id) {
      json(res, 400, { error: 'invalid_client' });
      return;
    }
    if (responseType !== 'code') {
      json(res, 400, { error: 'unsupported_response_type' });
      return;
    }
    if (!codeChallenge) {
      json(res, 400, { error: 'invalid_request', error_description: 'PKCE required' });
      return;
    }
    const code = randomBytes(16).toString('base64url');
    state.codes.set(code, {
      code,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      user: USER.username,
      expiresAt: Date.now() + 60_000,
    });

    const target = new URL(redirectUri || 'http://localhost/cb');
    target.searchParams.set('code', code);
    if (stateParam) target.searchParams.set('state', stateParam);
    res.writeHead(302, { location: target.toString() });
    res.end();
  },
};

const deviceAuthorizationEndpoint: AuthRoute = {
  method: 'POST',
  test: '/oauth/device_authorization',
  handle: ({ req, res, body }) => {
    const params = parseTokenRequest(req, body);
    if (params['client_id'] !== CLIENT.id) {
      json(res, 401, { error: 'invalid_client' });
      return;
    }
    const deviceCode = randomBytes(20).toString('base64url');
    const userCode = randomBytes(3).toString('hex').toUpperCase();
    state.devices.set(deviceCode, {
      deviceCode,
      userCode,
      clientId: params['client_id']!,
      scope: params['scope'] ?? 'read',
      status: 'pending',
      user: null,
      expiresAt: Date.now() + 600_000,
    });
    json(res, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: '/oauth/device_verification',
      expires_in: 600,
      interval: 1,
    });
  },
};

// Test-only helper: completes the device flow as if a user verified.
const deviceVerifyEndpoint: AuthRoute = {
  method: 'POST',
  test: '/oauth/_test/complete-device',
  handle: ({ req, res, body }) => {
    const params = parseTokenRequest(req, body);
    const dc = [...state.devices.values()].find((d) => d.userCode === (params['user_code'] ?? ''));
    if (!dc) {
      json(res, 404, { error: 'unknown_user_code' });
      return;
    }
    dc.status = params['action'] === 'deny' ? 'denied' : 'authorized';
    dc.user = USER.username;
    json(res, 200, { status: dc.status });
  },
};

const introspectEndpoint: AuthRoute = {
  method: 'POST',
  test: '/oauth/introspect',
  handle: ({ req, res, body }) => {
    const params = parseTokenRequest(req, body);
    const headerCreds = basicCreds(req);
    const clientId = headerCreds?.user ?? params['client_id'] ?? '';
    const clientSecret = headerCreds?.pass ?? params['client_secret'] ?? '';
    if (clientId !== CLIENT.id || clientSecret !== CLIENT.secret) {
      json(res, 401, { error: 'invalid_client' });
      return;
    }
    const tok = state.tokens.get(params['token'] ?? '');
    if (!tok || tok.expiresAt < Date.now()) {
      json(res, 200, { active: false });
      return;
    }
    json(res, 200, {
      active: true,
      scope: tok.scope,
      client_id: tok.clientId,
      username: tok.user,
      token_type: 'Bearer',
      exp: Math.floor(tok.expiresAt / 1000),
    });
  },
};

const userinfoEndpoint: AuthRoute = {
  method: 'GET',
  test: '/oauth/userinfo',
  handle: ({ req, res }) => {
    const token = bearerToken(req);
    if (!token) {
      state.challengeCount += 1;
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="restura-mock"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const verified = verifyJwt(token);
    if (!verified.ok) {
      json(res, 401, { error: 'invalid_token', reason: verified.reason });
      return;
    }
    const tok = state.tokens.get(token);
    json(res, 200, {
      sub: verified.payload?.sub,
      preferred_username: tok?.user ?? verified.payload?.sub,
      scope: tok?.scope ?? verified.payload?.scope,
    });
  },
};

const protectedEndpoint: AuthRoute = {
  method: 'GET',
  test: '/oauth/protected',
  handle: ({ req, res }) => {
    const token = bearerToken(req);
    if (!token) {
      state.challengeCount += 1;
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="restura-mock"' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const verified = verifyJwt(token);
    if (!verified.ok) {
      json(res, 401, { error: 'invalid_token', reason: verified.reason });
      return;
    }
    // Revocation check: a refresh deletes the previous token from the store.
    // A signature-valid JWT that's no longer in `state.tokens` has been rotated.
    if (!state.tokens.has(token)) {
      json(res, 401, { error: 'invalid_token', reason: 'revoked' });
      return;
    }
    json(res, 200, { ok: true, sub: verified.payload?.sub });
  },
};

const apiKeyHeaderEndpoint: AuthRoute = {
  method: 'GET',
  test: /^\/api-key\/header\/([^/]+)\/([^/]+)$/,
  handle: ({ req, res, match }) => {
    const expectedKey = decodeURIComponent(match![1]!);
    const expectedValue = decodeURIComponent(match![2]!);
    const provided = String(req.headers[expectedKey.toLowerCase()] ?? '');
    if (provided !== expectedValue) {
      state.challengeCount += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', expected: 'header api key' }));
      return;
    }
    json(res, 200, { authenticated: true, via: 'header', key: expectedKey });
  },
};

const apiKeyQueryEndpoint: AuthRoute = {
  method: 'GET',
  test: /^\/api-key\/query\/([^/]+)\/([^/]+)$/,
  handle: ({ res, url, match }) => {
    const expectedKey = decodeURIComponent(match![1]!);
    const expectedValue = decodeURIComponent(match![2]!);
    if (url.searchParams.get(expectedKey) !== expectedValue) {
      state.challengeCount += 1;
      json(res, 401, { error: 'unauthorized', expected: 'query api key' });
      return;
    }
    json(res, 200, { authenticated: true, via: 'query', key: expectedKey });
  },
};

// Digest auth (RFC 7616), MD5 algorithm — the realm challenge advertises
// algorithm=MD5 and `verifyDigest` hashes with MD5 accordingly.
const digestEndpoint: AuthRoute = {
  method: 'GET',
  test: /^\/digest-auth\/([^/]+)\/([^/]+)$/,
  handle: ({ req, res, match }) => {
    const user = decodeURIComponent(match![1]!);
    const pass = decodeURIComponent(match![2]!);
    const authHeader = String(req.headers.authorization ?? '');
    if (!authHeader.startsWith('Digest ')) {
      state.challengeCount += 1;
      const nonce = randomBytes(16).toString('hex');
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Digest realm="restura-mock", qop="auth", algorithm=MD5, nonce="${nonce}", opaque="restura"`,
      });
      res.end(JSON.stringify({ authenticated: false }));
      return;
    }
    if (!verifyDigest(req, user, pass)) {
      json(res, 401, { authenticated: false, reason: 'digest verify failed' });
      return;
    }
    json(res, 200, { authenticated: true, user });
  },
};

const awsProtectedEndpoint: AuthRoute = {
  method: 'GET',
  test: '/aws/protected',
  handle: ({ req, res, body }) => {
    const result = verifySigV4(req, body);
    if (!result.ok) {
      state.challengeCount += 1;
      json(res, 401, { authenticated: false, reason: result.reason });
      return;
    }
    json(res, 200, { authenticated: true, accessKey: AWS.accessKey, region: AWS.region });
  },
};

const wsseProtectedEndpoint: AuthRoute = {
  method: 'GET',
  test: '/wsse/protected',
  handle: ({ req, res }) => {
    const result = verifyWsse(req, USER.username, USER.password);
    if (!result.ok) {
      state.challengeCount += 1;
      json(res, 401, { authenticated: false, reason: result.reason });
      return;
    }
    json(res, 200, { authenticated: true, user: USER.username });
  },
};

const oauth1ProtectedEndpoint: AuthRoute = {
  method: 'GET',
  test: '/oauth1/protected',
  handle: ({ req, res, url }) => {
    const authHeader = req.headers.authorization ?? '';
    if (!/^OAuth\s/i.test(authHeader)) {
      state.challengeCount += 1;
      json(res, 401, { authenticated: false, reason: 'missing OAuth Authorization header' });
      return;
    }
    // Verify with the INDEPENDENT RFC 5849 verifier (validated against the RFC
    // worked example) — not the client signer — so a 200 proves the desktop
    // OAuth1 wire-signing is correct, not merely self-consistent. `url.href`
    // reconstructs the exact scheme://host:port/path the client signed.
    const { valid, params } = verifyOAuth1('GET', url.href, authHeader, {
      consumerSecret: OAUTH1.consumerSecret,
      tokenSecret: OAUTH1.accessTokenSecret,
    });
    if (!valid) {
      state.challengeCount += 1;
      json(res, 401, { authenticated: false, reason: 'invalid oauth_signature' });
      return;
    }
    json(res, 200, {
      authenticated: true,
      consumerKey: params.oauth_consumer_key,
      signatureMethod: params.oauth_signature_method,
    });
  },
};

const jwksEndpoint: AuthRoute = {
  method: 'GET',
  test: '/.well-known/jwks.json',
  handle: ({ res }) => {
    // HS256 keys aren't published via JWKS, but real OPs surface their kid + alg list.
    json(res, 200, {
      keys: [{ kty: 'oct', alg: 'HS256', kid: 'restura-mock-1', use: 'sig' }],
    });
  },
};

const wellKnownEndpoint: AuthRoute = {
  method: 'GET',
  test: '/.well-known/openid-configuration',
  handle: ({ res, req, url }) => {
    const base = `http://${req.headers.host ?? `127.0.0.1:${url.port}`}`;
    json(res, 200, {
      issuer: 'restura-mock',
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      device_authorization_endpoint: `${base}/oauth/device_authorization`,
      introspection_endpoint: `${base}/oauth/introspect`,
      userinfo_endpoint: `${base}/oauth/userinfo`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'client_credentials',
        'password',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    });
  },
};

export const authRoutes: AuthRoute[] = [
  apiKeyHeaderEndpoint,
  apiKeyQueryEndpoint,
  digestEndpoint,
  awsProtectedEndpoint,
  wsseProtectedEndpoint,
  oauth1ProtectedEndpoint,
  tokenEndpoint,
  authorizeEndpoint,
  deviceAuthorizationEndpoint,
  deviceVerifyEndpoint,
  introspectEndpoint,
  userinfoEndpoint,
  protectedEndpoint,
  jwksEndpoint,
  wellKnownEndpoint,
];
