import type { AuthConfig } from '@/types';
import type { ProtocolAuthConfig, ProtocolAuthType } from '@shared/protocol/types';

/**
 * Auth helpers shared by every CLI executor.
 *
 * Header/query-based schemes (Bearer, Basic, API-key, OAuth2) are materialised
 * into headers/params here — the renderer normally does this before the proxy.
 * Wire-signed schemes (AWS SigV4, OAuth1, WSSE) need byte-exact signing and are
 * forwarded as a `ProtocolAuthConfig` to `executeHttpProxy` (HTTP path only).
 */

/**
 * Resolve a `SecretValue` (string | inline-ref | handle-ref) to plaintext.
 *
 * A `handle` ref points at an OS-keychain entry that only the Electron desktop
 * app can decrypt — it is unresolvable in the CLI. We THROW rather than return
 * undefined so the request fails loudly (errored → exit 1) instead of silently
 * going out unauthenticated and passing against a permissive endpoint.
 */
export function secretString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const r = v as { kind?: string; value?: string };
    if (r.kind === 'inline' && typeof r.value === 'string') return r.value;
    if (r.kind === 'handle') {
      throw new Error(
        'auth uses a desktop-only secret handle that cannot be resolved in the CLI; ' +
          're-export the collection with inline secret values for CI use'
      );
    }
  }
  return undefined;
}

/**
 * Apply header/query-based auth into the given maps. `params` is mutated only
 * for `api-key` with `in: query`; protocols without a query channel (gRPC, MCP)
 * may pass a throwaway object. Wire-signed schemes are intentionally ignored
 * here — see `toProtocolAuth`.
 */
export function applyAuthHeaders(
  auth: AuthConfig | undefined,
  headers: Record<string, string>,
  params: Record<string, string>
): void {
  if (!auth || auth.type === 'none') return;
  switch (auth.type) {
    case 'bearer': {
      const token = secretString(auth.bearer?.token);
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return;
    }
    case 'basic': {
      const username = auth.basic?.username ?? '';
      const password = secretString(auth.basic?.password) ?? '';
      const encoded = Buffer.from(`${username}:${password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      return;
    }
    case 'api-key': {
      const key = auth.apiKey?.key;
      const value = secretString(auth.apiKey?.value);
      if (!key || !value) return;
      if (auth.apiKey?.in === 'query') params[key] = value;
      else headers[key] = value;
      return;
    }
    case 'oauth2': {
      const token = secretString(auth.oauth2?.accessToken);
      if (token) {
        const tokenType = auth.oauth2?.tokenType ?? 'Bearer';
        headers['Authorization'] = `${tokenType} ${token}`;
      }
      return;
    }
    // aws-signature, oauth1, ntlm, wsse are sign-at-wire — handled by toProtocolAuth.
  }
}

/**
 * Project an `AuthConfig` into the `ProtocolAuthConfig` the shared HTTP proxy
 * expects, but ONLY for the wire-signed schemes (the renderer-applied schemes
 * are already in headers via `applyAuthHeaders`). Returns undefined otherwise.
 */
export function toProtocolAuth(auth: AuthConfig | undefined): ProtocolAuthConfig | undefined {
  if (!auth) return undefined;
  const wireTypes: ProtocolAuthType[] = ['aws-signature', 'oauth1', 'ntlm', 'wsse'];
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
  if (auth.wsse) {
    out.wsse = {
      username: auth.wsse.username,
      password: secretString(auth.wsse.password) ?? '',
      ...(auth.wsse.passwordType ? { passwordType: auth.wsse.passwordType } : {}),
    };
  }
  return out;
}
