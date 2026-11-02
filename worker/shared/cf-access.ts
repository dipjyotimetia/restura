/**
 * Cloudflare Access verification for `REQUIRE_CF_ACCESS`.
 *
 * Trust comes only from the signed `Cf-Access-Jwt-Assertion`: its signature against
 * the team's published keys, its issuer, audience and validity window. Uses Web
 * Crypto, so the Worker and the Node entry run the same code with no dependency.
 */
import type { Env } from '../env';

export interface CfAccessConfig {
  /** `https://<team>.cloudflareaccess.com`: built here, so never an arbitrary host. */
  issuer: string;
  audience: string;
}

const TEAM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_ASSERTION_LENGTH = 16 * 1024;
const CLOCK_SKEW_SECONDS = 60;
const KEY_TTL_MS = 10 * 60 * 1000;
/** An unknown `kid` refreshes at most this often, so it can't drive a fetch per request. */
const MIN_REFRESH_MS = 60 * 1000;
const CERTS_TIMEOUT_MS = 5000;

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

/** The team's issuer and audience, or null when either is missing or unusable. */
export function readCfAccessConfig(
  env: Pick<Env, 'CF_ACCESS_TEAM_DOMAIN' | 'CF_ACCESS_AUD'>
): CfAccessConfig | null {
  const audience = env.CF_ACCESS_AUD?.trim();
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/$/, '')
    .replace(/\.cloudflareaccess\.com$/, '');
  if (!audience || !team || !TEAM_NAME.test(team)) return null;
  return { issuer: `https://${team}.cloudflareaccess.com`, audience };
}

interface KeySet {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const keySets = new Map<string, KeySet>();
const inFlight = new Map<string, Promise<KeySet>>();
const lastFailure = new Map<string, number>();

/** For tests. */
export function resetCfAccessKeyCache(): void {
  keySets.clear();
  inFlight.clear();
  lastFailure.clear();
}

async function fetchKeySet(issuer: string): Promise<KeySet> {
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    // `error` throws on workerd. A manual 3xx fails the `ok` check below.
    redirect: 'manual',
    signal: AbortSignal.timeout(CERTS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Access certs returned ${response.status}`);
  const body = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    const { kid, ...material } = jwk;
    keys.set(kid, await crypto.subtle.importKey('jwk', material, ALGORITHM, false, ['verify']));
  }
  return { keys, fetchedAt: Date.now() };
}

/** One fetch at a time per team, and none for a while after one failed. */
function refreshKeySet(issuer: string): Promise<KeySet> {
  const failedAt = lastFailure.get(issuer);
  if (failedAt !== undefined && Date.now() - failedAt < MIN_REFRESH_MS) {
    return Promise.reject(new Error('Access certs recently unavailable'));
  }
  const pending = inFlight.get(issuer);
  if (pending) return pending;
  const fetching = fetchKeySet(issuer)
    .then((fresh) => {
      keySets.set(issuer, fresh);
      lastFailure.delete(issuer);
      return fresh;
    })
    .catch((error: unknown) => {
      lastFailure.set(issuer, Date.now());
      throw error;
    })
    .finally(() => inFlight.delete(issuer));
  inFlight.set(issuer, fetching);
  return fetching;
}

async function findKey(issuer: string, kid: string): Promise<CryptoKey | undefined> {
  const cached = keySets.get(issuer);
  const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
  const key = cached?.keys.get(kid);
  if (key && age < KEY_TTL_MS) return key;
  // A known key past its TTL refreshes; so does an unknown one, but rate-limited.
  if (!cached || age >= (key ? KEY_TTL_MS : MIN_REFRESH_MS)) {
    return (await refreshKeySet(issuer)).keys.get(kid);
  }
  return key;
}

function decodeBytes(segment: string): Uint8Array<ArrayBuffer> {
  const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(new TextDecoder().decode(decodeBytes(segment)));
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function claimsAreValid(claims: Record<string, unknown>, config: CfAccessConfig): boolean {
  const { iss, aud, exp, nbf } = claims;
  const now = Date.now() / 1000;
  if (iss !== config.issuer) return false;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(config.audience)) return false;
  if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS <= now) return false;
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf - CLOCK_SKEW_SECONDS > now)) {
    return false;
  }
  return true;
}

/** True only for a correctly signed, current assertion for this team and audience. */
export async function verifyCfAccessAssertion(
  assertion: string | undefined,
  config: CfAccessConfig
): Promise<boolean> {
  if (!assertion || assertion.length > MAX_ASSERTION_LENGTH) return false;
  const [header, payload, signature, extra] = assertion.split('.');
  if (!header || !payload || !signature || extra !== undefined) return false;
  try {
    const head = decodeJson(header);
    if (head?.alg !== 'RS256' || typeof head.kid !== 'string') return false;
    const claims = decodeJson(payload);
    if (!claims || !claimsAreValid(claims, config)) return false;
    const key = await findKey(config.issuer, head.kid);
    if (!key) return false;
    return await crypto.subtle.verify(
      ALGORITHM,
      key,
      decodeBytes(signature),
      new TextEncoder().encode(`${header}.${payload}`)
    );
  } catch {
    // Malformed input or unreachable keys: an unverified caller is refused.
    return false;
  }
}
