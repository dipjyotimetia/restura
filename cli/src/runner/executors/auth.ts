import { fetchClientCredentialsToken, tokenExpiresAt } from '@shared/auth/oauth2';
import { buildAuthCredential, type CredentialHost } from '@shared/protocol/request-spec';
import type { ProtocolAuthConfig, ProtocolAuthType } from '@shared/protocol/types';
import { validateURL } from '@shared/protocol/url-validation';
import type { AuthConfig } from '@shared/types';

/**
 * Auth helpers shared by every CLI executor.
 *
 * Header/query-based schemes (Bearer, Basic, API-key, OAuth2) are materialised
 * into headers/params here — the renderer normally does this before the proxy.
 * Wire-signed schemes (AWS SigV4, OAuth1, WSSE) need byte-exact signing, and
 * Digest is answered after the server's 401 challenge; both are forwarded as a
 * `ProtocolAuthConfig` to `executeHttpProxy` (HTTP path only).
 */

/**
 * Resolve a `SecretValue` (string | inline-ref | handle-ref) to plaintext.
 *
 * A `handle` ref points at an OS-keychain entry that only the Electron desktop
 * app can decrypt — it is unresolvable in the CLI. We THROW rather than return
 * undefined so the request fails loudly (errored → exit 1) instead of silently
 * going out unauthenticated and passing against a permissive endpoint.
 *
 * The same goes for an `external` ref still here (materialized ones are already
 * strings, see `materializeExternalSecretsInAuth`) and for an object of no known
 * shape: dropping either would send the request unauthenticated, or sign it with
 * an empty secret. Errors never name the secret's identifiers.
 */
export function secretString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const r = v as { kind?: string; value?: string };
    if (r.kind === 'inline') return typeof r.value === 'string' ? r.value : undefined;
    if (r.kind === 'handle') {
      throw new Error(
        'auth uses a desktop-only secret handle that cannot be resolved in the CLI; ' +
          're-export the collection with inline secret values for CI use'
      );
    }
    if (r.kind === 'external') {
      throw new Error(
        'auth uses an external secret reference that was not resolved for this request; ' +
          'HTTP and MCP requests resolve one through an explicit external-secret profile, ' +
          'other protocols need an inline value'
      );
    }
    throw new Error('auth uses an unrecognised secret value; the request was not sent');
  }
  return undefined;
}

const CLI_CREDENTIAL_HOST: CredentialHost = {
  // The CLI has nothing to defer to: `secretString` reads the value or throws.
  readSecret: secretString,
  encodeBasic: (credentials) => Buffer.from(credentials).toString('base64'),
};

/**
 * Apply header/query-based auth into the given maps, by the rule the app uses
 * (`shared/protocol/request-spec.ts`). `params` is mutated only for `api-key`
 * with `in: query`; protocols without a query channel (gRPC, MCP) may pass a
 * throwaway object. Wire-signed schemes are intentionally ignored here — see
 * `toProtocolAuth`.
 */
export function applyAuthHeaders(
  auth: AuthConfig | undefined,
  headers: Record<string, string>,
  params: Record<string, string>
): void {
  const credential = buildAuthCredential(auth, CLI_CREDENTIAL_HOST);
  Object.assign(headers, credential.headers);
  Object.assign(params, credential.params);
}

interface CachedToken {
  accessToken: string;
  tokenType: string;
  /** epoch ms; undefined = no expiry info, reuse for the whole run. */
  expiresAt?: number;
}
const oauth2TokenCache = new Map<string, CachedToken>();

/**
 * For an OAuth2 auth that has a token endpoint + client id but no access token,
 * fetch one via the **client_credentials** grant — the only non-interactive
 * grant appropriate for CI — and return a copy of the auth carrying the token.
 *
 * Everything else is returned unchanged: a non-oauth2 auth, an oauth2 config
 * that already has a token, or one declaring an interactive grant
 * (authorization_code / password / device_code). OpenCollection import drops
 * `grantType`, so an unset grantType with a token endpoint is treated as
 * client_credentials. Tokens are cached (per token-url + client + scope) so a
 * collection of N requests hits the token endpoint once, not N times.
 */
export async function resolveOAuth2Token(
  auth: AuthConfig | undefined,
  /** @deprecated Unused — pass auth already resolved with `resolveAuthVariables`. */
  _vars: Record<string, string>,
  opts: { allowLocalhost?: boolean; fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {}
): Promise<AuthConfig | undefined> {
  if (!auth || auth.type !== 'oauth2' || !auth.oauth2) return auth;
  const o = auth.oauth2;
  if (secretString(o.accessToken)) return auth; // already authenticated
  if (o.grantType && o.grantType !== 'client_credentials') return auth;

  // Callers resolve `{{vars}}` once with the shared `resolveAuthVariables`
  // BEFORE external secrets are materialized. Re-resolving here would expand
  // external-secret plaintext and variable values that contain `{{…}}`.
  const tokenUrl = o.tokenUrl ?? '';
  const clientId = o.clientId ?? '';
  if (!tokenUrl || !clientId) return auth;

  const clientSecret = secretString(o.clientSecret) || undefined;
  const scope = o.scope || undefined;

  const cacheKey = `${tokenUrl}|${clientId}|${scope ?? ''}`;
  const now = Date.now();
  const cached = oauth2TokenCache.get(cacheKey);
  if (cached && (cached.expiresAt === undefined || cached.expiresAt > now + 5000)) {
    return withAccessToken(auth, o, cached.accessToken, cached.tokenType);
  }

  // SSRF guard on the token endpoint, mirroring the request path.
  const validation = validateURL(tokenUrl, {
    allowPrivateIPs: false,
    allowLocalhost: opts.allowLocalhost ?? false,
  });
  if (!validation.valid) throw new Error(`OAuth2 token URL blocked: ${validation.error}`);

  const token = await fetchClientCredentialsToken(
    {
      grantType: 'client_credentials',
      clientId,
      tokenUrl,
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      ...(scope !== undefined ? { scope } : {}),
    },
    {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }
  );
  const tokenType = token.token_type ?? 'Bearer';
  const expiresAt = tokenExpiresAt(now, token.expires_in);
  oauth2TokenCache.set(cacheKey, {
    accessToken: token.access_token,
    tokenType,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
  return withAccessToken(auth, o, token.access_token, tokenType);
}

function withAccessToken(
  auth: AuthConfig,
  o: NonNullable<AuthConfig['oauth2']>,
  accessToken: string,
  tokenType: string
): AuthConfig {
  return { ...auth, oauth2: { ...o, accessToken, tokenType } };
}

/**
 * Project an `AuthConfig` into the `ProtocolAuthConfig` the shared HTTP proxy
 * expects, but ONLY for the wire-signed schemes (the renderer-applied schemes
 * are already in headers via `applyAuthHeaders`). Returns undefined otherwise.
 */
export function toProtocolAuth(auth: AuthConfig | undefined): ProtocolAuthConfig | undefined {
  if (!auth) return undefined;
  const wireTypes: ProtocolAuthType[] = ['aws-signature', 'oauth1', 'ntlm', 'wsse', 'digest'];
  if (!wireTypes.includes(auth.type as ProtocolAuthType)) return undefined;
  const out: ProtocolAuthConfig = { type: auth.type as ProtocolAuthType };
  if (auth.awsSignature) {
    out.awsSignature = {
      accessKey: auth.awsSignature.accessKey,
      secretKey: secretString(auth.awsSignature.secretKey) ?? '',
      region: auth.awsSignature.region,
      service: auth.awsSignature.service,
    };
  }
  if (auth.oauth1) {
    out.oauth1 = {
      consumerKey: auth.oauth1.consumerKey,
      consumerSecret: secretString(auth.oauth1.consumerSecret) ?? '',
      ...(auth.oauth1.accessToken !== undefined
        ? { accessToken: secretString(auth.oauth1.accessToken) ?? '' }
        : {}),
      ...(auth.oauth1.accessTokenSecret !== undefined
        ? { accessTokenSecret: secretString(auth.oauth1.accessTokenSecret) ?? '' }
        : {}),
      ...(auth.oauth1.signatureMethod ? { signatureMethod: auth.oauth1.signatureMethod } : {}),
      ...(auth.oauth1.realm ? { realm: auth.oauth1.realm } : {}),
      ...(auth.oauth1.nonce ? { nonce: auth.oauth1.nonce } : {}),
      ...(auth.oauth1.timestamp ? { timestamp: auth.oauth1.timestamp } : {}),
      ...(auth.oauth1.addParamsToBody !== undefined
        ? { addParamsToBody: auth.oauth1.addParamsToBody }
        : {}),
    };
  }
  if (auth.ntlm) {
    out.ntlm = {
      username: auth.ntlm.username,
      password: secretString(auth.ntlm.password) ?? '',
      ...(auth.ntlm.domain ? { domain: auth.ntlm.domain } : {}),
      ...(auth.ntlm.workstation ? { workstation: auth.ntlm.workstation } : {}),
    };
  }
  if (auth.digest) {
    out.digest = {
      username: auth.digest.username,
      password: secretString(auth.digest.password) ?? '',
    };
  }
  if (auth.wsse) {
    out.wsse = {
      username: auth.wsse.username,
      password: secretString(auth.wsse.password) ?? '',
      ...(auth.wsse.passwordType ? { passwordType: auth.wsse.passwordType } : {}),
    };
  }
  return out;
}
