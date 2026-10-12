import { SECRET_FIELDS_BY_AUTH_BLOCK } from '../secrets/auth-fields';
import type { SecretValue } from '../secrets/secret-ref';
import type { AuthConfig } from '../types';

/**
 * Internal `AuthConfig` → OpenCollection auth block (export side). Inverse of
 * `authToInternal` in `to-internal.ts`; split out of `from-internal.ts` to keep
 * that module under the architecture file-size cap.
 */

/**
 * Render a SecretValue for the OC text format. Inline values become plaintext
 * (the document is a portable file; redaction is the export dialog's job),
 * handles become a `{{handle:<label>}}` placeholder — the keychain plaintext
 * never leaves the machine. Mirrors `exportSecretValue` in the Postman/
 * Insomnia exporters. Without this, post-ADR-0007 auth (SecretValue objects)
 * would serialize as `{kind: inline, value: …}` blobs into the YAML.
 */
function secretToString(value: SecretValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value.kind === 'inline') return value.value;
  if (value.kind === 'external')
    return `{{external:${value.provider}:${value.profileId}:${value.secretId}${value.selector ? `:${value.selector}` : ''}}}`;
  return `{{handle:${value.label ?? value.id}}}`;
}

/** oauth2 fields that hold SecretValues and need unwrapping on export. */
const OAUTH2_SECRET_FIELDS = new Set(['accessToken', 'refreshToken', 'clientSecret', 'password']);

export function authFromInternal(a?: AuthConfig): unknown {
  if (!a || a.type === 'none') return undefined;
  switch (a.type) {
    case 'basic':
      return {
        type: 'basic',
        username: a.basic?.username ?? '',
        password: secretToString(a.basic?.password),
      };
    case 'bearer':
      return { type: 'bearer', token: secretToString(a.bearer?.token) };
    case 'api-key':
      return {
        type: 'apikey',
        key: a.apiKey?.key ?? '',
        value: secretToString(a.apiKey?.value),
        placement: a.apiKey?.in ?? 'header',
      };
    case 'aws-signature':
      return {
        type: 'awsv4',
        accessKeyId: a.awsSignature?.accessKey ?? '',
        secretAccessKey: secretToString(a.awsSignature?.secretKey),
        region: a.awsSignature?.region ?? '',
        service: a.awsSignature?.service ?? '',
      };
    case 'digest':
      return {
        type: 'digest',
        username: a.digest?.username ?? '',
        password: secretToString(a.digest?.password),
      };
    case 'oauth2': {
      const out: Record<string, unknown> = { type: 'oauth2' };
      const o = a.oauth2 ?? {};
      for (const [k, v] of Object.entries(o)) {
        if (v === undefined) continue;
        out[k] = OAUTH2_SECRET_FIELDS.has(k) ? secretToString(v as SecretValue) : v;
      }
      return out;
    }
    // OAuth1 / NTLM / WSSE use the spec's field names (#869). The Restura-only
    // knobs the upstream schema lacks (`addParamsToBody`, `workstation`,
    // `passwordType`) are emitted only when set, so a document using none of
    // them stays strictly spec-shaped.
    case 'oauth1': {
      const o = a.oauth1;
      const out: Record<string, unknown> = {
        type: 'oauth1',
        consumerKey: o?.consumerKey ?? '',
        consumerSecret: secretToString(o?.consumerSecret),
      };
      if (o?.accessToken !== undefined) out.accessToken = secretToString(o.accessToken);
      if (o?.accessTokenSecret !== undefined) {
        out.accessTokenSecret = secretToString(o.accessTokenSecret);
      }
      if (o?.signatureMethod !== undefined) out.signatureMethod = o.signatureMethod;
      if (o?.realm !== undefined) out.realm = o.realm;
      if (o?.nonce !== undefined) out.nonce = o.nonce;
      if (o?.timestamp !== undefined) out.timestamp = o.timestamp;
      if (o?.addParamsToBody !== undefined) out.addParamsToBody = o.addParamsToBody;
      return out;
    }
    case 'ntlm': {
      const out: Record<string, unknown> = {
        type: 'ntlm',
        username: a.ntlm?.username ?? '',
        password: secretToString(a.ntlm?.password),
      };
      if (a.ntlm?.domain !== undefined) out.domain = a.ntlm.domain;
      if (a.ntlm?.workstation !== undefined) out.workstation = a.ntlm.workstation;
      return out;
    }
    case 'wsse': {
      const out: Record<string, unknown> = {
        type: 'wsse',
        username: a.wsse?.username ?? '',
        password: secretToString(a.wsse?.password),
      };
      if (a.wsse?.passwordType !== undefined) out.passwordType = a.wsse.passwordType;
      return out;
    }
    default:
      return undefined;
  }
}

/**
 * Flatten every SecretValue in an AuthConfig to its exportable string form so
 * both compare-sides live in the same space: cached OC auth holds plain
 * strings, post-ADR-0007 internal auth holds SecretValue objects. (A local
 * walk over the shared field map rather than `migrateAuthConfigToSecretRef`
 * — that module pulls in `platform.ts`, which the CLI tsconfig can't compile.)
 */
export function unwrapAuthForCompare(a: AuthConfig): AuthConfig {
  const out = { ...a };
  for (const [block, fields] of Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK)) {
    const cur = out[block as keyof AuthConfig];
    if (!cur || typeof cur !== 'object') continue;
    const copy = { ...cur } as Record<string, unknown>;
    for (const f of fields) {
      if (f in copy) copy[f] = secretToString(copy[f] as SecretValue | undefined);
    }
    (out as unknown as Record<string, unknown>)[block as string] = copy;
  }
  return out;
}
