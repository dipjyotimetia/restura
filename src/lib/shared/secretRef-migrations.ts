import { isConfiguredAuth } from '@shared/auth/inheritance';
import {
  activeAuthBlock,
  mapPostmanAuthParams,
  postmanAuthParamEntries,
} from '@shared/collections/postman/auth';
import { hasUnsupportedPostmanAuth } from '@shared/collections/postman/auth-guard';
import { isExplicitNoauth, sameAuth } from '@shared/collections/postman/auth-identity';
import {
  isAuthSecretRow,
  isPostmanAuthSecretKey,
  redactPostmanBag,
} from '@shared/collections/postman/redaction';
import { getPostmanSidecar } from '@shared/collections/postman/sidecar';
import type { AuthConfig, Collection, CollectionItem, Request } from '@/types';
import { SECRET_FIELDS_BY_AUTH_BLOCK } from './auth-secret-fields';
import { getElectronAPI, isElectron } from './platform';
import { coerceToInlineSecret, isInlineSecretRef } from './secretRef';

type SecretBlock = keyof typeof SECRET_FIELDS_BY_AUTH_BLOCK;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Copy EVERY key of an auth block and re-wrap only its secret fields (the
 * shared `SECRET_FIELDS_BY_AUTH_BLOCK` map) as inline SecretValues. Carrying
 * non-secret keys through by spread means a newly added field (e.g.
 * `oauth2.issuer`) can never be silently dropped by this migration again.
 * Optional secrets stay absent when the source lacks them.
 */
function rewrapSecrets(
  source: Record<string, unknown>,
  block: SecretBlock
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...source };
  for (const field of SECRET_FIELDS_BY_AUTH_BLOCK[block]) {
    if (source[field] !== undefined) out[field] = coerceToInlineSecret(source[field]);
  }
  return out;
}

/**
 * Walk an AuthConfig and rewrap its sensitive fields (see ADR-0007) as
 * `{ kind: 'inline', value }`. Non-sensitive metadata (usernames, region,
 * realm, URLs, issuer, etc.) is carried through untouched; required fields
 * are defaulted so the result satisfies `AuthConfig`. Idempotent.
 */
export function migrateAuthConfigToSecretRef(auth: unknown): AuthConfig | undefined {
  const a = asRecord(auth);
  if (!a) return undefined;
  const out: AuthConfig = { type: (a.type as AuthConfig['type']) ?? 'none' };

  const basic = asRecord(a.basic);
  if (basic) {
    out.basic = {
      ...rewrapSecrets(basic, 'basic'),
      username: str(basic.username),
      password: coerceToInlineSecret(basic.password),
    };
  }
  const bearer = asRecord(a.bearer);
  if (bearer) {
    out.bearer = { ...rewrapSecrets(bearer, 'bearer'), token: coerceToInlineSecret(bearer.token) };
  }
  const apiKey = asRecord(a.apiKey);
  if (apiKey) {
    out.apiKey = {
      ...rewrapSecrets(apiKey, 'apiKey'),
      key: str(apiKey.key),
      value: coerceToInlineSecret(apiKey.value),
      in: apiKey.in === 'query' ? 'query' : 'header',
    };
  }
  const oauth2 = asRecord(a.oauth2);
  if (oauth2) {
    out.oauth2 = {
      ...rewrapSecrets(oauth2, 'oauth2'),
      accessToken: coerceToInlineSecret(oauth2.accessToken),
    };
  }
  const digest = asRecord(a.digest);
  if (digest) {
    out.digest = {
      ...rewrapSecrets(digest, 'digest'),
      username: str(digest.username),
      password: coerceToInlineSecret(digest.password),
    };
  }
  const aws = asRecord(a.awsSignature);
  if (aws) {
    out.awsSignature = {
      ...rewrapSecrets(aws, 'awsSignature'),
      accessKey: str(aws.accessKey),
      secretKey: coerceToInlineSecret(aws.secretKey),
      region: str(aws.region),
      service: str(aws.service),
    };
  }
  const oauth1 = asRecord(a.oauth1);
  if (oauth1) {
    out.oauth1 = {
      ...rewrapSecrets(oauth1, 'oauth1'),
      consumerKey: str(oauth1.consumerKey),
      consumerSecret: coerceToInlineSecret(oauth1.consumerSecret),
    };
  }
  const ntlm = asRecord(a.ntlm);
  if (ntlm) {
    out.ntlm = {
      ...rewrapSecrets(ntlm, 'ntlm'),
      username: str(ntlm.username),
      password: coerceToInlineSecret(ntlm.password),
    };
  }
  const wsse = asRecord(a.wsse);
  if (wsse) {
    out.wsse = {
      ...rewrapSecrets(wsse, 'wsse'),
      username: str(wsse.username),
      password: coerceToInlineSecret(wsse.password),
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
      // A rejected invoke (e.g. the secret channel's rate limit on a very
      // large import burst) must degrade exactly like `!result.ok`: keep the
      // inline value and move on. Letting it throw would abort the whole
      // import via Promise.all and orphan every handle already stored.
      let result: { ok: true; id: string } | { ok: false; error: string };
      try {
        result = await api.secrets.store({ value: plaintext, label });
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) {
        block[field] = { kind: 'handle', id: result.id, label };
      }
    }
  }
  return next;
}

/**
 * The nearest ancestor (collection or folder) whose auth an inheriting request
 * would take: its auth BEFORE conversion (for the identity check) and after
 * (whose handles an identical request reuses).
 */
interface AncestorAuth {
  original: AuthConfig;
  converted: AuthConfig;
}

/**
 * What a container hands its children, mirroring the Postman exporters'
 * `authForChildren`: a configured auth becomes the new nearest ancestor; an
 * explicit `none` (Postman `noauth`) or an unsupported auth imported as `none`
 * cuts the chain; any other unconfigured auth (absent, or a plain `none`)
 * passes the parent's ancestor through.
 */
function ancestorForChildren(
  node: object,
  original: AuthConfig | undefined,
  converted: AuthConfig | undefined,
  inherited: AncestorAuth | undefined
): AncestorAuth | undefined {
  if (hasUnsupportedPostmanAuth(node)) return undefined;
  if (isExplicitNoauth(original, getPostmanSidecar(node))) return undefined;
  if (isConfiguredAuth(original) && converted) return { original, converted };
  return inherited;
}

/**
 * Walk a Collection tree and convert every request's inline sensitive auth
 * field into a keychain-backed handle. Returns a new tree; original is not
 * mutated. No-op on web (silently passes the collection through).
 *
 * #1226: importers bake an inheriting request's ancestor auth into the
 * request. Minting a fresh handle there makes `sameAuth` see two different
 * credentials, so a Postman export writes an explicit blank-secret block
 * instead of `inherit`. A request whose WHOLE auth config equals its NEAREST
 * ancestor's (secrets compared by plaintext via `sameAuth`) therefore reuses
 * that ancestor's handles — never across siblings, never past a chain cut.
 * Sharing an id is safe because the auth editor always mints a new handle
 * rather than overwriting one in place (`SecretInput`), and deleting a
 * request or collection never reaps handles (the invariant
 * `duplicateCollection` relies on too; `secretStoreNoOverwrite.test.ts` pins
 * the no-`id` rule). Consequences of sharing: a manual delete in
 * Settings → Secrets removes the credential from EVERY location sharing the
 * handle, and the shared handle carries the ancestor's label
 * (`<collection>/<folder>/...`), not the request's.
 */
export async function convertCollectionSecretsToHandles(
  collection: Collection
): Promise<Collection> {
  if (!isElectron()) return collection;
  const api = getElectronAPI();
  const store: SecretsStore | undefined = api?.secrets?.store
    ? (args) => api.secrets.store(args)
    : undefined;
  // An ancestor's auth is converted before its children so they can reuse it.
  const auth = await convertInlineSecretsToHandles(
    collection.auth,
    `${collection.name}/<collection>`
  );
  const ancestor = ancestorForChildren(collection, collection.auth, auth, undefined);
  const items = await Promise.all(
    (collection.items ?? []).map((item) =>
      convertItemSecretsToHandles(item, collection.name, store, ancestor)
    )
  );
  const bag = store
    ? await convertPostmanBagToHandles(collection, `${collection.name}/<collection>`, store)
    : {};
  return { ...collection, items, ...(auth ? { auth } : {}), ...bag };
}

async function convertItemSecretsToHandles(
  item: CollectionItem,
  prefix: string,
  store: SecretsStore | undefined,
  inherited: AncestorAuth | undefined
): Promise<CollectionItem> {
  if (item.type === 'folder') {
    // Folder-level default auth carries secrets too (mirrors collection.auth).
    const auth = await convertInlineSecretsToHandles(item.auth, `${prefix}/${item.name}/<folder>`);
    const ancestor = ancestorForChildren(item, item.auth, auth, inherited);
    const items = await Promise.all(
      (item.items ?? []).map((sub) =>
        convertItemSecretsToHandles(sub, `${prefix}/${item.name}`, store, ancestor)
      )
    );
    const bag = store
      ? await convertPostmanBagToHandles(item, `${prefix}/${item.name}/<folder>`, store)
      : {};
    return { ...item, items, ...(auth ? { auth } : {}), ...bag };
  }
  const bag = store ? await convertPostmanBagToHandles(item, `${prefix}/${item.name}`, store) : {};
  if (item.request && 'auth' in item.request) {
    const req = item.request as Request & { auth: AuthConfig };
    const auth =
      inherited && isConfiguredAuth(req.auth) && sameAuth(req.auth, inherited.original)
        ? (structuredClone(inherited.converted) as AuthConfig)
        : await convertInlineSecretsToHandles(req.auth, `${prefix}/${item.name}`);
    if (auth) {
      return { ...item, request: { ...req, auth } as typeof item.request, ...bag };
    }
  }
  return { ...item, ...bag };
}

type SecretsStore = (args: {
  value: string;
  label: string;
}) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;

/**
 * Convert one Postman auth parameter value (v2.1 `[{ key, value }]` entry or
 * v2.0 map value) to a handle. FAILS CLOSED: if the keychain store rejects,
 * the value is blanked rather than kept. The sidecar is reference-only, and
 * plaintext there is exactly what handle storage was asked to avoid.
 */
async function postmanParamToHandle(
  store: SecretsStore,
  key: string,
  value: unknown,
  label: string
): Promise<unknown> {
  // Nested parameter rows (OAuth2 `tokenRequestParams` / `refreshRequestParams`
  // / `authRequestParams`: `[{ key, value, send_as }]`) are judged row by row,
  // never by the param's own key — the same predicate the export redactor uses
  // (#1233). Non-secret rows are kept as they are.
  if (Array.isArray(value)) {
    return Promise.all(
      value.map(async (row, i) => {
        if (!isAuthSecretRow(row)) return row;
        const r = row as { key?: unknown; value?: unknown };
        const rowLabel = `${label}.${typeof r.key === 'string' ? r.key : i}`;
        return { ...(row as object), value: await credentialToHandle(store, r.value, rowLabel) };
      })
    );
  }
  if (!isPostmanAuthSecretKey(key)) return value;
  return credentialToHandle(store, value, label);
}

/** One credential value → handle. FAILS CLOSED (blank) on any non-string or store failure. */
async function credentialToHandle(
  store: SecretsStore,
  value: unknown,
  label: string
): Promise<unknown> {
  if (value === undefined || value === null || value === '') return value;
  // A non-string credential (number, boolean, object) cannot become a handle
  // and must not persist in plaintext either: blank it.
  if (typeof value !== 'string') return '';
  try {
    const result = await store({ value, label });
    return result.ok ? { kind: 'handle', id: result.id, label } : '';
  } catch {
    return '';
  }
}

/**
 * `auth` is the ORIGINAL block (plaintext needed to mint handles); `redacted`
 * is its `redactPostmanBag` copy. Only the active `[type]` block is rebuilt
 * from the original — every other key comes from the redacted copy, so a
 * hostile sibling block (`bearer: [...]` beside `type: 'hawk'`) stays blanked.
 */
async function postmanAuthToHandles(
  store: SecretsStore,
  auth: Record<string, unknown>,
  redacted: Record<string, unknown>,
  labelPrefix: string
): Promise<Record<string, unknown>> {
  const { type, block } = activeAuthBlock(auth);
  if (block === undefined) return redacted;
  const label = (key: string) => `${labelPrefix}/_postman.${type}.${key}`;
  const values = await Promise.all(
    postmanAuthParamEntries(block).map((p) =>
      postmanParamToHandle(store, p.key, p.value, label(p.key))
    )
  );
  const next = mapPostmanAuthParams(block, (_p, i) => values[i]);
  return { ...redacted, [type]: next };
}

/**
 * ADR 0034 / ADR-0007: a Postman `_postman` sidecar can hold bag-only
 * credentials (unsupported hawk / edgegrid / jwt auth, an OAuth1 RSA
 * `privateKey`, refresh tokens) plus saved-response headers, cookies and
 * bodies. When the user opts into handle storage, credential auth params
 * become keychain handles and every other secret-bearing value is blanked
 * (`redactPostmanBag`), so no plaintext persists anywhere in the collection.
 */
async function convertPostmanBagToHandles(
  node: object,
  labelPrefix: string,
  store: SecretsStore
): Promise<{ _postman?: unknown }> {
  const bag = getPostmanSidecar(node);
  if (!bag || typeof bag !== 'object') return {};
  const original = bag as Record<string, unknown>;
  const next = redactPostmanBag(bag) as Record<string, unknown>;
  const auth = original.auth;
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    next.auth = await postmanAuthToHandles(
      store,
      auth as Record<string, unknown>,
      next.auth as Record<string, unknown>,
      labelPrefix
    );
  }
  return { _postman: next };
}
