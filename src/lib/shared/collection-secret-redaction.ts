import { SECRET_FIELDS_BY_AUTH_BLOCK } from '@/lib/shared/auth-secret-fields';
import {
  redactSecretKeyValues,
  countSecretKeyValues,
  type SecretableRow,
} from '@/lib/shared/keyvalue-secret-redaction';
import {
  isSecretHandle,
  redactSecret,
  unwrapSecret,
  type SecretValue,
} from '@/lib/shared/secretRef';
import type { AuthConfig, Collection, CollectionItem } from '@/types';

/**
 * Redacts secret-bearing auth fields from a collection before it goes through
 * a renderer-side exporter (Postman / Insomnia / OpenCollection / Bruno).
 * Without this, a plaintext bearer token / API key / AWS secret key lands in
 * the file the user shares with a teammate, commits to git, or pastes into a
 * chat tool.
 *
 * Semantics (via `redactSecret`):
 *  - Inline plaintext (`string` or `{ kind: 'inline', value }`) → empty.
 *  - Handle references (`{ kind: 'handle', id }`) → preserved; the id is
 *    opaque on its own and the exporters render it as a `{{handle:label}}`
 *    placeholder.
 *
 * Non-secret fields (username, region, key name, URLs, scopes…) are kept so
 * a redacted export still round-trips the auth *shape* — only the credential
 * material is dropped. The Electron file-collection redactor
 * (`electron/main/security/collection-export-redactor.ts`) implements the same policy
 * for untyped auth blobs; both consume `SECRET_FIELDS_BY_AUTH_BLOCK`.
 */

/** True for a non-empty plaintext secret (inline or bare string) — handles never count. */
function isInlineWithValue(value: SecretValue | undefined): boolean {
  return !isSecretHandle(value) && unwrapSecret(value) !== '';
}

/** Returns a copy of `auth` with every known secret-bearing field redacted. */
export function redactAuthConfigSecrets(auth: AuthConfig): AuthConfig {
  const next: AuthConfig = { ...auth };
  for (const [block, fields] of Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK)) {
    const current = next[block as keyof AuthConfig];
    if (!current || typeof current !== 'object') continue;
    const copy = { ...current } as Record<string, unknown>;
    for (const field of fields) {
      if (field in copy) {
        copy[field] = redactSecret(copy[field] as SecretValue | undefined);
      }
    }
    (next as unknown as Record<string, unknown>)[block] = copy;
  }
  return next;
}

function countAuthInlineSecrets(auth: AuthConfig | undefined): number {
  if (!auth) return 0;
  let count = 0;
  for (const [block, fields] of Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK)) {
    const current = auth[block as keyof AuthConfig] as Record<string, unknown> | undefined;
    if (!current || typeof current !== 'object') continue;
    for (const field of fields) {
      if (isInlineWithValue(current[field] as SecretValue | undefined)) count++;
    }
  }
  return count;
}

/**
 * True when an OpenCollection `_oc` passthrough bag contains an `auth` block
 * anywhere in its tree (item auth, folder request-defaults auth, or any
 * descendant's). Used to decide whether the bag is safe to keep on a
 * redacted export.
 */
function ocBagHasAuth(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(ocBagHasAuth);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'auth' && value && typeof value === 'object') return true;
    if (ocBagHasAuth(value)) return true;
  }
  return false;
}

/**
 * OpenCollection auth `type`s whose plaintext IS captured by the typed internal
 * model (and therefore counted via {@link countAuthInlineSecrets}). Any other
 * non-empty type degrades to `type:'none'` on import (OAuth1/NTLM/WSSE/…),
 * leaving its credential material ONLY in the `_oc` passthrough bag.
 *
 * Keep in sync with `authToInternal` in `src/lib/opencollection/to-internal.ts`
 * (its non-`default` cases) — that switch decides which types reach the typed
 * model; this set must mirror it or the bag counter will double- or under-count.
 */
const TYPED_OC_AUTH_TYPES = new Set([
  'none',
  'basic',
  'bearer',
  'apikey',
  'awsv4',
  'digest',
  'oauth2',
]);

/**
 * String credential fields on OC degrade-to-none auth blocks (OAuth1/NTLM/WSSE).
 * `password` covers NTLM/WSSE; `consumerSecret`/`accessTokenSecret` cover OAuth1.
 * (OAuth1 `privateKey` is object-valued and handled separately in
 * {@link countAuthBlockSecrets}; cert passphrases are handled by `obj.passphrase`
 * in {@link countOcBagInlineSecrets}.)
 */
const OC_SECRET_FIELDS = new Set(['password', 'consumerSecret', 'accessTokenSecret']);

function hasNonEmptyString(obj: Record<string, unknown>, fields: Set<string>): boolean {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string' && v.length > 0) return true;
  }
  return false;
}

/**
 * Counts plaintext secrets that live ONLY in an OpenCollection `_oc` passthrough
 * bag — i.e. credentials the typed counters cannot see: degrade-to-none auth
 * (OAuth1/NTLM/WSSE) and root config secrets (cert passphrases, proxy password).
 * Without this, a collection whose only secret is in a bag returns count 0, the
 * export dialog never fires, and a non-redacted OpenCollection export emits the
 * verbatim bag with plaintext (ADR-0007 violation).
 *
 * Supported auth types (bearer/basic/…) are deliberately ignored here — their
 * plaintext is already in typed fields and counted there; counting the bag copy
 * too would double-report.
 */
function countAuthBlockSecrets(a: Record<string, unknown>): number {
  const type = typeof a.type === 'string' ? a.type : undefined;
  if (type === undefined) {
    // Untyped auth block (e.g. an OC proxy's `config.auth { username, password }`,
    // which has no `type`) — a non-empty password is a plaintext secret the
    // internal model never captures.
    return typeof a.password === 'string' && a.password.length > 0 ? 1 : 0;
  }
  if (TYPED_OC_AUTH_TYPES.has(type)) return 0;
  // Degrade-to-none request auth (OAuth1/NTLM/WSSE): plaintext lives only here.
  let n = hasNonEmptyString(a, OC_SECRET_FIELDS) ? 1 : 0;
  // OAuth1 RSA `privateKey` is an object `{ type: 'file' | 'text', value }`; an
  // inline ('text') key is a secret. A 'file' value is a path, not a secret.
  if (a.privateKey && typeof a.privateKey === 'object') {
    const pk = a.privateKey as Record<string, unknown>;
    if (pk.type === 'text' && typeof pk.value === 'string' && pk.value.length > 0) n += 1;
  }
  return n;
}

function countOcBagInlineSecrets(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce<number>((n, v) => n + countOcBagInlineSecrets(v), 0);
  const obj = node as Record<string, unknown>;
  let count = 0;
  const auth = obj.auth;
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    count += countAuthBlockSecrets(auth as Record<string, unknown>);
  }
  // Cert / private-key passphrase (root `config.clientCertificates[].passphrase`
  // and per-environment certs) — a string field the internal model never sees.
  if (typeof obj.passphrase === 'string' && obj.passphrase.length > 0) count += 1;
  for (const [key, value] of Object.entries(obj)) {
    // `auth` is handled above; `passphrase` is a scalar already counted. Recurse
    // everything else (incl. `proxy` → `proxy.config.auth`) so nested config
    // secrets like the proxy password are reached.
    if (key === 'auth' || key === 'passphrase') continue;
    count += countOcBagInlineSecrets(value);
  }
  return count;
}

function redactItem(item: CollectionItem): CollectionItem {
  const next: CollectionItem = { ...item };
  // The _oc passthrough bag holds the verbatim imported node — including any
  // plaintext auth from the source document — and the OC exporter prefers
  // per-item bags verbatim with no auth gate at the request tier. Drop the
  // bag when it carries an auth block anywhere (the rebuild loses
  // byte-stability but never leaks). Auth-free bags are kept deliberately:
  // GraphQL items and WebSocket placeholders survive OC export *only*
  // through their bag, so dropping those unconditionally would degrade them
  // to plain-HTTP / empty-folder shapes.
  if (ocBagHasAuth((next as { _oc?: unknown })._oc)) {
    delete (next as { _oc?: unknown })._oc;
  }
  if (next.auth) next.auth = redactAuthConfigSecrets(next.auth);
  if (next.items) next.items = next.items.map(redactItem);
  if (next.request) {
    // Redact the typed auth block AND any secret-bearing header / query-param /
    // metadata row (a token typed into a header is just as exfiltrable).
    const req = { ...next.request } as unknown as Record<string, unknown>;
    if (Array.isArray(req.headers))
      req.headers = redactSecretKeyValues(req.headers as SecretableRow[]);
    if (Array.isArray(req.params))
      req.params = redactSecretKeyValues(req.params as SecretableRow[]);
    if (Array.isArray(req.metadata))
      req.metadata = redactSecretKeyValues(req.metadata as SecretableRow[]);
    if ('auth' in req) req.auth = redactAuthConfigSecrets(req.auth as AuthConfig);
    next.request = req as unknown as typeof next.request;
  }
  return next;
}

/**
 * Returns a copy of the collection with every inline secret blanked —
 * collection-level auth, folder-level auth, and each request's auth.
 * Handle references are preserved. The original is not mutated.
 *
 * OpenCollection `_oc` passthrough bags are dropped on every item whose bag
 * carries an auth block: per-item bags are emitted verbatim by the OC
 * exporter with no auth gate at the request tier, so a surviving
 * auth-bearing bag would leak the original (pre-redaction) plaintext.
 * Auth-free item bags are kept: they carry fidelity that can't be rebuilt
 * (GraphQL/WebSocket shapes).
 *
 * The collection-level `_oc` bag is dropped unconditionally. It holds the
 * entire pre-redaction document, and the exporter's root staleness gate
 * (`authUnchanged`) compares in *internal* space — blind to auth types that
 * degrade to 'none' on import (OAuth1/NTLM/WSSE) and to root config secrets
 * the internal model never sees (proxy passwords, cert passphrases). With
 * the bag gone, the exporter rebuilds the root tier from the redacted model
 * (Strategy 3); per-item bags still apply, so item fidelity is unaffected.
 * Redacted exports trade byte-stability for "never leaks" by design.
 */
export function redactCollectionSecrets(collection: Collection): Collection {
  const next = { ...collection } as Collection & { _oc?: unknown };
  delete next._oc;
  return {
    ...next,
    ...(collection.auth ? { auth: redactAuthConfigSecrets(collection.auth) } : {}),
    items: collection.items.map(redactItem),
  };
}

/**
 * Counts non-empty inline (plaintext) secrets across the collection's auth
 * configs. Used by the export flow to decide whether to warn the user before
 * writing plaintext credentials into an export file. Handle references don't
 * count — they never expose plaintext.
 */
export function countCollectionInlineSecrets(collection: Collection): number {
  let count = countAuthInlineSecrets(collection.auth);
  const rootOc = (collection as { _oc?: unknown })._oc;
  // The root `_oc` bag holds the entire verbatim OC document, so walking it
  // covers every item's bag too. When it has been stripped (a post-import edit
  // strips `_oc` along the mutated path), fall back to the surviving per-item
  // bags instead — this avoids double-counting the common fresh-import case.
  if (rootOc !== undefined) {
    count += countOcBagInlineSecrets(rootOc);
  }
  const walk = (items: CollectionItem[]) => {
    for (const item of items) {
      count += countAuthInlineSecrets(item.auth);
      if (rootOc === undefined) {
        count += countOcBagInlineSecrets((item as { _oc?: unknown })._oc);
      }
      if (item.request) {
        const req = item.request as unknown as Record<string, unknown>;
        if ('auth' in req) count += countAuthInlineSecrets(req.auth as AuthConfig | undefined);
        count += countSecretKeyValues(req.headers as SecretableRow[] | undefined);
        count += countSecretKeyValues(req.params as SecretableRow[] | undefined);
        count += countSecretKeyValues(req.metadata as SecretableRow[] | undefined);
      }
      if (item.items) walk(item.items);
    }
  };
  walk(collection.items);
  return count;
}
