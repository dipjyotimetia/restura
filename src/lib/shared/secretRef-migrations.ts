import type { AuthConfig, Collection, CollectionItem, Request } from '@/types';
import { isElectron, getElectronAPI } from './platform';
import { coerceToInlineSecret, isInlineSecretRef } from './secretRef';

/** Internal: only include the field if the source had it (preserves optional-undefined shape). */
function pickSecret<K extends string>(
  source: Record<string, unknown>,
  key: K
): Partial<Record<K, ReturnType<typeof coerceToInlineSecret>>> {
  return source[key] !== undefined
    ? ({ [key]: coerceToInlineSecret(source[key]) } as Record<
        K,
        ReturnType<typeof coerceToInlineSecret>
      >)
    : {};
}

function pickString<K extends string>(
  source: Record<string, unknown>,
  key: K
): Partial<Record<K, string>> {
  return typeof source[key] === 'string'
    ? ({ [key]: source[key] as string } as Record<K, string>)
    : {};
}

/**
 * Walk an AuthConfig and rewrap the 14 sensitive fields (see ADR-0007) as
 * `{ kind: 'inline', value }`. Non-sensitive metadata (usernames, region,
 * realm, URLs, etc.) is untouched. Idempotent — running twice is safe.
 */
export function migrateAuthConfigToSecretRef(auth: unknown): AuthConfig | undefined {
  if (!auth || typeof auth !== 'object') return undefined;
  const a = auth as Partial<AuthConfig> & Record<string, unknown>;
  const out: AuthConfig = { type: (a.type as AuthConfig['type']) ?? 'none' };

  if (a.basic && typeof a.basic === 'object') {
    const b = a.basic as { username?: unknown; password?: unknown };
    out.basic = {
      username: typeof b.username === 'string' ? b.username : '',
      password: coerceToInlineSecret(b.password),
    };
  }
  if (a.bearer && typeof a.bearer === 'object') {
    out.bearer = { token: coerceToInlineSecret((a.bearer as { token?: unknown }).token) };
  }
  if (a.apiKey && typeof a.apiKey === 'object') {
    const k = a.apiKey as { key?: unknown; value?: unknown; in?: unknown };
    out.apiKey = {
      key: typeof k.key === 'string' ? k.key : '',
      value: coerceToInlineSecret(k.value),
      in: k.in === 'query' ? 'query' : 'header',
    };
  }
  if (a.oauth2 && typeof a.oauth2 === 'object') {
    const o = a.oauth2 as Record<string, unknown>;
    out.oauth2 = {
      accessToken: coerceToInlineSecret(o.accessToken),
      ...pickString(o, 'tokenType'),
      ...pickSecret(o, 'refreshToken'),
      ...(typeof o.expiresAt === 'number' ? { expiresAt: o.expiresAt } : {}),
      ...(Array.isArray(o.scopes) ? { scopes: o.scopes as string[] } : {}),
      ...(typeof o.grantType === 'string'
        ? {
            grantType: o.grantType as
              | 'authorization_code'
              | 'client_credentials'
              | 'password'
              | 'device_code',
          }
        : {}),
      ...pickString(o, 'clientId'),
      ...pickSecret(o, 'clientSecret'),
      ...pickString(o, 'authorizationUrl'),
      ...pickString(o, 'tokenUrl'),
      ...pickString(o, 'deviceAuthorizationUrl'),
      ...pickString(o, 'scope'),
      ...pickString(o, 'redirectUri'),
      ...pickString(o, 'username'),
      ...pickSecret(o, 'password'),
    };
  }
  if (a.digest && typeof a.digest === 'object') {
    const d = a.digest as { username?: unknown; password?: unknown };
    out.digest = {
      username: typeof d.username === 'string' ? d.username : '',
      password: coerceToInlineSecret(d.password),
    };
  }
  if (a.awsSignature && typeof a.awsSignature === 'object') {
    const s = a.awsSignature as Record<string, unknown>;
    out.awsSignature = {
      accessKey: typeof s.accessKey === 'string' ? s.accessKey : '',
      secretKey: coerceToInlineSecret(s.secretKey),
      region: typeof s.region === 'string' ? s.region : '',
      service: typeof s.service === 'string' ? s.service : '',
    };
  }
  if (a.oauth1 && typeof a.oauth1 === 'object') {
    const o = a.oauth1 as Record<string, unknown>;
    out.oauth1 = {
      consumerKey: typeof o.consumerKey === 'string' ? o.consumerKey : '',
      consumerSecret: coerceToInlineSecret(o.consumerSecret),
      ...pickSecret(o, 'accessToken'),
      ...pickSecret(o, 'accessTokenSecret'),
      ...(typeof o.signatureMethod === 'string'
        ? { signatureMethod: o.signatureMethod as 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT' }
        : {}),
      ...pickString(o, 'realm'),
      ...pickString(o, 'nonce'),
      ...pickString(o, 'timestamp'),
      ...(typeof o.addParamsToBody === 'boolean' ? { addParamsToBody: o.addParamsToBody } : {}),
    };
  }
  if (a.ntlm && typeof a.ntlm === 'object') {
    const n = a.ntlm as Record<string, unknown>;
    out.ntlm = {
      username: typeof n.username === 'string' ? n.username : '',
      password: coerceToInlineSecret(n.password),
      ...pickString(n, 'domain'),
      ...pickString(n, 'workstation'),
    };
  }
  if (a.wsse && typeof a.wsse === 'object') {
    const w = a.wsse as Record<string, unknown>;
    out.wsse = {
      username: typeof w.username === 'string' ? w.username : '',
      password: coerceToInlineSecret(w.password),
      ...(typeof w.passwordType === 'string'
        ? { passwordType: w.passwordType as 'PasswordDigest' | 'PasswordText' }
        : {}),
    };
  }

  return out;
}

/**
 * Sensitive `AuthConfig` field paths per ADR-0007. Used by the importer's
 * opt-in handle conversion: for each non-empty inline value, store via
 * `electronAPI.secrets.store` and replace with a handle.
 */
const SENSITIVE_AUTH_PATHS: ReadonlyArray<[keyof AuthConfig, readonly string[]]> = [
  ['basic', ['password']],
  ['bearer', ['token']],
  ['apiKey', ['value']],
  ['oauth2', ['accessToken', 'refreshToken', 'clientSecret', 'password']],
  ['oauth1', ['consumerSecret', 'accessToken', 'accessTokenSecret']],
  ['awsSignature', ['secretKey']],
  ['digest', ['password']],
  ['ntlm', ['password']],
  ['wsse', ['password']],
];

/**
 * Convert every non-empty inline SecretValue in an `AuthConfig` to an opaque
 * handle by storing the plaintext in the OS keychain via the renderer→main
 * IPC. No-op on web (no keychain) and on already-handle values.
 *
 * `labelPrefix` is included in each handle's label so the Settings → Secrets
 * panel can show "<collection>/<request>/<field>".
 */
export async function convertInlineSecretsToHandles(
  auth: AuthConfig | undefined,
  labelPrefix: string
): Promise<AuthConfig | undefined> {
  if (!auth || !isElectron()) return auth;
  const api = getElectronAPI();
  if (!api?.secrets?.store) return auth;

  const next = JSON.parse(JSON.stringify(auth)) as AuthConfig;
  for (const [method, fields] of SENSITIVE_AUTH_PATHS) {
    const block = next[method] as Record<string, unknown> | undefined;
    if (!block) continue;
    for (const field of fields) {
      const current = block[field];
      const plaintext =
        typeof current === 'string'
          ? current
          : isInlineSecretRef(current as never)
            ? (current as { value: string }).value
            : null;
      if (plaintext === null || plaintext === '') continue;
      const label = `${labelPrefix}/${method}.${field}`;
      const result = await api.secrets.store({ value: plaintext, label });
      if (result.ok) {
        block[field] = { kind: 'handle', id: result.id, label };
      }
    }
  }
  return next;
}

/**
 * Walk a Collection tree and convert every request's inline sensitive auth
 * field into a keychain-backed handle. Returns a new tree; original is not
 * mutated. No-op on web (silently passes the collection through).
 */
export async function convertCollectionSecretsToHandles(
  collection: Collection
): Promise<Collection> {
  if (!isElectron()) return collection;
  const items = await Promise.all(
    (collection.items ?? []).map((item) => convertItemSecretsToHandles(item, collection.name))
  );
  const auth = await convertInlineSecretsToHandles(
    collection.auth,
    `${collection.name}/<collection>`
  );
  return { ...collection, items, ...(auth ? { auth } : {}) };
}

async function convertItemSecretsToHandles(
  item: CollectionItem,
  prefix: string
): Promise<CollectionItem> {
  if (item.type === 'folder') {
    const items = await Promise.all(
      (item.items ?? []).map((sub) => convertItemSecretsToHandles(sub, `${prefix}/${item.name}`))
    );
    // Folder-level default auth carries secrets too (mirrors collection.auth).
    const auth = await convertInlineSecretsToHandles(item.auth, `${prefix}/${item.name}/<folder>`);
    return { ...item, items, ...(auth ? { auth } : {}) };
  }
  if (item.request && 'auth' in item.request) {
    const req = item.request as Request & { auth: AuthConfig };
    const auth = await convertInlineSecretsToHandles(req.auth, `${prefix}/${item.name}`);
    if (auth) {
      return { ...item, request: { ...req, auth } as typeof item.request };
    }
  }
  return item;
}
