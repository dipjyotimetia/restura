import {
  MAX_COLLECTION_TREE_DEPTH,
  PASSTHROUGH_BAG_KEYS,
  type PassthroughBagKey,
} from '../collections/passthrough-bags';
import { countPostmanBagInlineSecrets, redactPostmanBag } from '../collections/postman/redaction';
import { getPostmanSidecar } from '../collections/postman/sidecar';
import {
  countUrlStringSecrets,
  REFERENCE_ONLY_VALUE,
  redactUrlCredentialsForStorage,
  redactVariableValue,
} from '../collections/postman/text-redaction';
import type { Collection, CollectionItem, ScopedVariable } from '../types';
import { hasUrlUserinfo, stripUrlUserinfo } from './broker-preset-redaction';
import { isSecretFieldName } from './key-value-redaction';
import {
  blankRequestSecrets,
  countAuthInlineSecrets,
  countRequestSecrets,
  redactAuthConfigSecrets,
} from './request-secret-slots';
import { isSecretHandle, redactSecret } from './secret-ref';
import { redactOcStdioEnv } from './stdio-env-redaction';

export { redactAuthConfigSecrets };

/**
 * Redacts secret-bearing fields from a collection before it goes through
 * a renderer-side exporter (Postman / Insomnia / OpenCollection / Bruno).
 *
 * This module owns the tree and the passthrough bags, which are not mirrors of
 * each other (see the walks below). A request's own fields are one list, in
 * `request-secret-slots.ts`: a new saved Protocol shape goes there, not here.
 *
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
 * Non-secret fields (username, region, key name, scopes…) and URLs minus their
 * userinfo and credential query values are kept, so a redacted export still
 * round-trips the auth *shape* — only the credential material is dropped. The Electron file-collection redactor
 * (`electron/main/security/collection-export-redactor.ts`) implements the same policy
 * for untyped auth blobs; both consume `SECRET_FIELDS_BY_AUTH_BLOCK`.
 */

/**
 * OpenCollection auth `type`s whose string credentials ARE captured by the
 * typed internal model (and therefore counted via {@link countAuthInlineSecrets}).
 * Any other non-empty type degrades to `type:'none'` on import, leaving its
 * credential material ONLY in the `_oc` passthrough bag.
 *
 * Applies ONLY to auth on modelled OC nodes. Auth inside an opaque item
 * ({@link MODELLED_OC_ITEM_TYPES}) never reaches the typed model whatever its
 * type, so the bag counter counts all of its credentials.
 *
 * Keep in sync with `authToInternal` in `shared/opencollection/to-internal.ts`
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
  'oauth1',
  'ntlm',
  'wsse',
]);

/**
 * String credential fields on OC degrade-to-none auth blocks (unknown types
 * that still carry the familiar field names). (OAuth1 `privateKey` is
 * object-valued and never reaches the typed model — handled separately in
 * {@link countAuthBlockSecrets}; cert passphrases are handled by `obj.passphrase`
 * in {@link countOcBagInlineSecrets}.)
 */
const OC_SECRET_FIELDS = new Set(['password', 'consumerSecret', 'accessTokenSecret']);
const ALL_OC_AUTH_SECRET_FIELDS = new Set([
  ...OC_SECRET_FIELDS,
  'token',
  'value',
  'secretAccessKey',
  'sessionToken',
  'accessToken',
  'refreshToken',
  'clientSecret',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Nested credential objects inside an OC auth block. The OC schema nests OAuth2
 * secrets (`credentials.clientSecret`, `resourceOwner.password`); Restura's
 * `authToInternal` only reads the flat fields, so nested material is bag-only
 * for EVERY node — typed or opaque. `privateKey` is excluded: it is
 * `{ type: 'file' | 'text', value }` and a file path is not a secret, so it is
 * handled explicitly.
 */
function nestedAuthObjects(
  auth: Record<string, unknown>
): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const [key, value] of Object.entries(auth)) {
    if (key !== 'privateKey' && isPlainObject(value)) out.push([key, value]);
  }
  return out;
}

/** Bag keys holding a URL or address, whichever protocol or extension they sit in. */
const OC_URL_KEYS = new Set([
  'url',
  'brokerUrl',
  'endpoint',
  'tokenUrl',
  'authorizationUrl',
  'deviceAuthorizationUrl',
  'accessTokenUrl',
  'refreshTokenUrl',
  'redirectUri',
  'callbackUrl',
  'issuer',
]);

/** A broker address follows the typed slot's rule, so the two copies cannot disagree. */
function redactOcUrlValue(key: string, value: string): string {
  return key === 'brokerUrl' ? stripUrlUserinfo(value) : redactUrlCredentialsForStorage(value);
}

function countOcUrlKeys(obj: Record<string, unknown>): number {
  let n = 0;
  for (const key of OC_URL_KEYS) {
    const value = obj[key];
    if (typeof value !== 'string') continue;
    n += key === 'brokerUrl' ? (hasUrlUserinfo(value) ? 1 : 0) : countUrlStringSecrets(value);
  }
  if (Array.isArray(obj.bootstrapBrokers)) {
    n += obj.bootstrapBrokers.filter((b) => typeof b === 'string' && hasUrlUserinfo(b)).length;
  }
  return n;
}

/** A bag `{ name | key, value }` variable row whose value the policy would change. */
function ocVariableRowValue(row: unknown): { value: string; next: string } | null {
  if (!isPlainObject(row) || typeof row.value !== 'string') return null;
  const name = typeof row.name === 'string' ? row.name : typeof row.key === 'string' ? row.key : '';
  const next = redactVariableValue(name, row.value);
  return next === row.value ? null : { value: row.value, next };
}

function redactOcAuthBlock(auth: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...auth };
  for (const key of OC_URL_KEYS) {
    const value = next[key];
    if (typeof value === 'string') next[key] = redactOcUrlValue(key, value);
  }
  for (const field of ALL_OC_AUTH_SECRET_FIELDS) {
    if (typeof next[field] === 'string') next[field] = '';
  }
  for (const [key, nested] of nestedAuthObjects(next)) {
    next[key] = redactOcAuthBlock(nested);
  }
  if (isPlainObject(next.privateKey)) {
    const privateKey = next.privateKey;
    if (privateKey.type === 'text' && typeof privateKey.value === 'string') {
      next.privateKey = { ...privateKey, value: '' };
    }
  }
  return next;
}

/** OC key/value row lists whose credential-named rows are blanked (typed-model parity). */
const OC_ROW_LIST_KEYS = new Set(['headers', 'params', 'metadata']);

/**
 * Blank credential-named OC `{ name, value }` rows. Without this a cached bag
 * re-emits e.g. an MCP `Authorization` header verbatim even though the typed
 * request's headers were redacted (#896).
 */
function redactOcRows(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (!isPlainObject(row)) return redactOcBag(row);
    if (isPlaintextSecretOcRow(row)) return { ...row, value: '' };
    return redactOcBag(row);
  });
}

/**
 * A cached OC `{ name, value }` row holding plaintext credential material.
 * A value that is entirely one `{{var}}` reference is left alone — it names
 * where the secret lives, and blanking it would needlessly rewrite the
 * git-native files of opaque (WebSocket / Socket.IO) items. Bag-only policy;
 * the typed model's `redactSecretKeyValues` is unchanged.
 */
function isPlaintextSecretOcRow(row: Record<string, unknown>): boolean {
  const name = typeof row.name === 'string' ? row.name : typeof row.key === 'string' ? row.key : '';
  return (
    typeof row.value === 'string' &&
    row.value !== '' &&
    !REFERENCE_ONLY_VALUE.test(row.value.trim()) &&
    (row.secret === true || isSecretFieldName(name))
  );
}

function countOcRowSecrets(rows: unknown[]): number {
  return rows.reduce<number>(
    (n, row) => (isPlainObject(row) && isPlaintextSecretOcRow(row) ? n + 1 : n),
    0
  );
}

/** Preserve unknown OC fields/extensions while blanking credentials in cached bags. */
export function redactOcBag(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(redactOcBag);
  const input = node as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (OC_ROW_LIST_KEYS.has(key) && Array.isArray(value)) {
      output[key] = redactOcRows(value);
    } else if (key === 'auth' && value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = redactOcAuthBlock(value as Record<string, unknown>);
    } else if (key === 'passphrase' && typeof value === 'string') {
      output[key] = '';
    } else if (OC_URL_KEYS.has(key) && typeof value === 'string') {
      // URL userinfo + credential-named query values (`?access_token=`): an
      // unedited item re-exports verbatim from its bag (#1209).
      output[key] = redactOcUrlValue(key, value);
    } else if (key === 'variables' && Array.isArray(value)) {
      output[key] = value.map((row) => {
        const changed = ocVariableRowValue(row);
        return redactOcBag(changed ? { ...(row as object), value: changed.next } : row);
      });
    } else if (key === 'bootstrapBrokers' && Array.isArray(value)) {
      output[key] = value.map((b) => (typeof b === 'string' ? stripUrlUserinfo(b) : b));
    } else if (key === 'value' && input.secret === true) {
      output[key] = '';
    } else if (key === 'stdio' && isPlainObject(value) && Array.isArray(value.env)) {
      output[key] = { ...(redactOcBag(value) as object), env: redactOcStdioEnv(value.env) };
    } else {
      output[key] = redactOcBag(value);
    }
  }
  return output;
}

function hasNonEmptyString(obj: Record<string, unknown>, fields: Set<string>): boolean {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string' && v.length > 0) return true;
  }
  return false;
}

function countNonEmptyStrings(obj: Record<string, unknown>, fields: Set<string>): number {
  let n = 0;
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string' && v.length > 0) n++;
  }
  return n;
}

/**
 * OpenCollection item `info.type`s that `itemToInternal` in
 * `shared/opencollection/to-internal.ts` turns into a typed internal request.
 * Every other typed item (`websocket`, `socketio`, any future/unknown type)
 * becomes a folder PLACEHOLDER whose content — auth included — lives ONLY in
 * the `_oc` bag, invisible to the typed counters. OC folders carry no
 * `info.type`; `x-restura-sse` / `x-restura-mcp` extension entries are typed
 * via `placeExtensionItems` and are recognised by key context instead (see
 * {@link MODELLED_OC_EXTENSION_LISTS}).
 *
 * Keep in sync with `itemToInternal`'s `info.type` dispatch (and
 * `placeExtensionItems`) — a type modelled there but missing here is
 * double-counted; a type listed here but no longer modelled is UNDER-counted
 * (export plaintext warning suppressed).
 */
// `websocket` stays opaque even though a WebSocket item is typed since #1209:
// pre-#1209 placeholder folders still hold the whole item only in their bag.
// For a typed WebSocket item its header rows are therefore counted twice
// (typed + bag) — an over-count, the safe direction for the export warning.
const MODELLED_OC_ITEM_TYPES = new Set(['http', 'graphql', 'grpc']);

/**
 * Modelled item types whose `auth` block is NOT modelled: a WebSocket item
 * (#1209) becomes a typed request (url / headers / messages) but Restura has
 * no WebSocket auth, so its OC `auth` lives only in the `_oc` bag and every
 * credential in it is bag-only.
 */
const AUTH_OPAQUE_OC_ITEM_TYPES = new Set(['websocket']);

/** OC extension lists whose entries `placeExtensionItems` imports as typed requests. */
const MODELLED_OC_EXTENSION_LISTS = new Set([
  'x-restura-sse',
  'x-restura-mcp',
  'x-restura-kafka',
  'x-restura-mqtt',
  'x-restura-socketio',
]);

function isAuthOpaqueOcItem(obj: Record<string, unknown>): boolean {
  const info = obj.info;
  return (
    isPlainObject(info) && typeof info.type === 'string' && AUTH_OPAQUE_OC_ITEM_TYPES.has(info.type)
  );
}

/** True for an OC item node that `itemToInternal` keeps only as an opaque `_oc` bag. */
function isOpaqueOcItem(obj: Record<string, unknown>): boolean {
  const info = obj.info;
  return (
    isPlainObject(info) && typeof info.type === 'string' && !MODELLED_OC_ITEM_TYPES.has(info.type)
  );
}

/** Non-empty credentials in nested auth objects (OAuth2 `credentials` / `resourceOwner`). */
function countNestedAuthSecrets(a: Record<string, unknown>): number {
  let n = 0;
  for (const [, nested] of nestedAuthObjects(a)) {
    n +=
      countNonEmptyStrings(nested, ALL_OC_AUTH_SECRET_FIELDS) +
      countOcUrlKeys(nested) +
      countNestedAuthSecrets(nested);
  }
  return n;
}

/**
 * Counts plaintext secrets in one OC auth block that the typed counters cannot
 * see. `opaque` is true when the block belongs to an unmodelled item (see
 * {@link isOpaqueOcItem}): there is no typed copy at all, so EVERY credential
 * field counts regardless of auth type. In a modelled node the flat string
 * credentials of supported types (bearer/basic/oauth1/ntlm/wsse/…) are already
 * counted on the typed model — counting the bag copy too would double-report —
 * so only bag-only material counts: degrade-to-none types, nested OAuth2
 * credential objects, and OAuth1 inline RSA keys.
 */
function countAuthBlockSecrets(a: Record<string, unknown>, opaque: boolean): number {
  const type = typeof a.type === 'string' ? a.type : undefined;
  let n: number;
  if (opaque) {
    n = countNonEmptyStrings(a, ALL_OC_AUTH_SECRET_FIELDS);
  } else if (type === undefined) {
    // Untyped auth block (e.g. an OC proxy's `config.auth { username, password }`,
    // which has no `type`) — a non-empty password is a plaintext secret the
    // internal model never captures.
    n = typeof a.password === 'string' && a.password.length > 0 ? 1 : 0;
  } else {
    // Degrade-to-none (unknown) types: plaintext lives only in the bag.
    n = !TYPED_OC_AUTH_TYPES.has(type) && hasNonEmptyString(a, OC_SECRET_FIELDS) ? 1 : 0;
  }
  // Nested credential objects never reach the typed model, whatever the node.
  n += countNestedAuthSecrets(a);
  // An over-count for a modelled node's OAuth URLs (typed + bag), the safe direction.
  n += countOcUrlKeys(a);
  // OAuth1 RSA `privateKey` is an object `{ type: 'file' | 'text', value }`; an
  // inline ('text') key is a secret. A 'file' value is a path, not a secret.
  if (isPlainObject(a.privateKey)) {
    const pk = a.privateKey;
    if (pk.type === 'text' && typeof pk.value === 'string' && pk.value.length > 0) n += 1;
  }
  return n;
}

/**
 * Counts plaintext secrets that live ONLY in an OpenCollection `_oc` passthrough
 * bag — i.e. credentials the typed counters cannot see: auth inside opaque
 * (unmodelled) items, degrade-to-none auth, nested OAuth2 credentials, inline
 * OAuth1 RSA keys, and root config secrets (cert passphrases, proxy password).
 * Without this, a collection whose only secret is in a bag returns count 0, the
 * export dialog never fires, and a non-redacted OpenCollection export emits the
 * verbatim bag with plaintext (ADR-0007 violation).
 *
 * @param opaque - `node` sits inside an opaque (unmodelled) OC item.
 * @param modelled - `node` is known to be a typed node (an SSE/MCP extension
 *   entry, or the bag of an internal `request` item) — skip the opacity probe.
 */
function countOcBagInlineSecrets(
  node: unknown,
  opaque = false,
  modelled = false,
  authOpaque = false
): number {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) {
    return node.reduce<number>(
      (n, v) => n + countOcBagInlineSecrets(v, opaque, modelled, authOpaque),
      0
    );
  }
  const obj = node as Record<string, unknown>;
  const inOpaque = opaque || (!modelled && isOpaqueOcItem(obj));
  const inAuthOpaque = inOpaque || authOpaque || isAuthOpaqueOcItem(obj);
  let count = 0;
  if (isPlainObject(obj.auth)) count += countAuthBlockSecrets(obj.auth, inAuthOpaque);
  // Cert / private-key passphrase (root `config.clientCertificates[].passphrase`
  // and per-environment certs) — a string field the internal model never sees.
  if (typeof obj.passphrase === 'string' && obj.passphrase.length > 0) count += 1;
  // URL userinfo / credential-named query values in a bag URL (a typed
  // request's copy may be counted too — an over-count, the safe direction).
  count += countOcUrlKeys(obj);
  for (const [key, value] of Object.entries(obj)) {
    // `auth` is handled above; `passphrase` is a scalar already counted. Recurse
    // everything else (incl. `proxy` → `proxy.config.auth`) so nested config
    // secrets like the proxy password are reached.
    if (key === 'auth' || key === 'passphrase') continue;
    if (key === 'variables' && Array.isArray(value)) {
      count += value.filter((row) => ocVariableRowValue(row) !== null).length;
    }
    // Credential header / param / metadata rows. Only bag-only material
    // counts: a modelled node's rows are already counted on the typed request
    // (`countSecretKeyValues`), so counting the bag copy would double-report.
    if (inOpaque && OC_ROW_LIST_KEYS.has(key) && Array.isArray(value)) {
      count += countOcRowSecrets(value);
      continue;
    }
    count += countOcBagInlineSecrets(
      value,
      inOpaque,
      MODELLED_OC_EXTENSION_LISTS.has(key),
      inAuthOpaque
    );
  }
  return count;
}

// `_postman` sidecar redaction lives with the Postman module
// (`shared/collections/postman/redaction.ts`); the walks below apply it to
// every bag alongside `_oc`.

/** Per-bag sanitisers, keyed by passthrough bag (iterated via `PASSTHROUGH_BAG_KEYS`). */
const BAG_REDACTORS: Record<PassthroughBagKey, (bag: unknown) => unknown> = {
  _oc: redactOcBag,
  _postman: redactPostmanBag,
};

function redactBags<T extends object>(node: T): T {
  const next = { ...node } as Record<string, unknown>;
  for (const key of PASSTHROUGH_BAG_KEYS) {
    if (next[key] !== undefined) next[key] = BAG_REDACTORS[key](next[key]);
  }
  return next as T;
}

// Past `MAX_COLLECTION_TREE_DEPTH` the walks fail closed: a subtree beyond the
// bound is replaced by an empty stub on redaction (nothing below it can leak)
// and counted as one secret (the export warning fires).

/** A saved contract spec pointer at collection or folder scope. */
interface ContractSpecHolder {
  contractSpec?: { url?: unknown } | undefined;
}

function contractSpecUrl(node: ContractSpecHolder): string | undefined {
  const url = node.contractSpec?.url;
  return typeof url === 'string' ? url : undefined;
}

function redactContractSpec<T extends object>(node: T): T {
  const holder = node as ContractSpecHolder;
  const url = contractSpecUrl(holder);
  if (url === undefined) return node;
  return {
    ...node,
    contractSpec: { ...holder.contractSpec, url: redactUrlCredentialsForStorage(url) },
  };
}

function countContractSpec(node: object): number {
  const url = contractSpecUrl(node as ContractSpecHolder);
  return url === undefined ? 0 : countUrlStringSecrets(url);
}

function variableIsFlagged(variable: ScopedVariable): boolean {
  return variable.secret === true || variable.secretRef !== undefined;
}

/** Plaintext in a flagged or `secretRef` variable (handles hold none), or under the name policy. */
function variableHoldsSecret(variable: ScopedVariable): boolean {
  const ref = variable.secretRef;
  if (variableIsFlagged(variable)) {
    if (variable.value) return true;
    if (typeof ref === 'string') return ref !== '';
    return ref?.kind === 'inline' && ref.value !== '';
  }
  return (
    typeof variable.value === 'string' &&
    redactVariableValue(String(variable.key), variable.value) !== variable.value
  );
}

function redactVariables<T extends object>(node: T): T {
  const variables = (node as { variables?: unknown }).variables;
  if (!Array.isArray(variables)) return node;
  return {
    ...node,
    variables: (variables as ScopedVariable[]).map((variable) => {
      if (!variableHoldsSecret(variable)) return variable;
      if (!variableIsFlagged(variable)) {
        return { ...variable, value: redactVariableValue(variable.key, variable.value) };
      }
      const ref = variable.secretRef;
      return {
        ...variable,
        value: '',
        ...(ref !== undefined && !isSecretHandle(ref) ? { secretRef: redactSecret(ref) } : {}),
      };
    }),
  };
}

/** Variables on a collection or folder that {@link redactCollectionSecrets} changes. */
export function countVariableSecrets(node: object): number {
  const variables = (node as { variables?: unknown }).variables;
  if (!Array.isArray(variables)) return 0;
  return (variables as ScopedVariable[]).filter(variableHoldsSecret).length;
}

function redactItem(item: CollectionItem, depth = 0): CollectionItem {
  if (depth > MAX_COLLECTION_TREE_DEPTH) {
    return { id: item.id, name: item.name, type: item.type, ...(item.items ? { items: [] } : {}) };
  }
  const next: CollectionItem = redactVariables(redactContractSpec(redactBags(item)));
  if (next.auth) next.auth = redactAuthConfigSecrets(next.auth);
  if (next.items) next.items = next.items.map((child) => redactItem(child, depth + 1));
  if (next.request) next.request = blankRequestSecrets(next.request);
  return next;
}

/**
 * Returns a copy of the collection with every inline secret blanked —
 * collection-level auth, folder-level auth, and each request's auth.
 * Handle references are preserved. The original is not mutated.
 *
 * OpenCollection `_oc` passthrough bags are recursively sanitised rather than
 * discarded. That keeps unknown extensions and unmodelled request shapes
 * round-trip stable while blanking typed and degrade-to-none auth secrets,
 * proxy passwords, private keys, certificate passphrases, and secret values.
 */
export function redactCollectionSecrets(collection: Collection): Collection {
  const next = redactVariables(redactContractSpec(redactBags(collection)));
  return {
    ...next,
    ...(collection.auth ? { auth: redactAuthConfigSecrets(collection.auth) } : {}),
    items: collection.items.map((item) => redactItem(item)),
  };
}

/**
 * Counts non-empty inline (plaintext) secrets across the collection's auth
 * configs. Used by the export flow to decide whether to warn the user before
 * writing plaintext credentials into an export file. Handle references don't
 * count — they never expose plaintext.
 */
export function countCollectionInlineSecrets(collection: Collection): number {
  let count =
    countAuthInlineSecrets(collection.auth) +
    countContractSpec(collection) +
    countVariableSecrets(collection);
  const rootOc = (collection as { _oc?: unknown })._oc;
  // The root `_oc` bag holds the entire verbatim OC document, so walking it
  // covers every item's bag too. When it has been stripped (a post-import edit
  // strips `_oc` along the mutated path), fall back to the surviving per-item
  // bags instead — this avoids double-counting the common fresh-import case.
  if (rootOc !== undefined) {
    count += countOcBagInlineSecrets(rootOc);
  }
  // `_postman` sidecars are per-node (never a whole-document copy): count each.
  count += countPostmanBagInlineSecrets(getPostmanSidecar(collection));
  const walk = (items: CollectionItem[], depth: number) => {
    if (depth > MAX_COLLECTION_TREE_DEPTH) {
      count += 1;
      return;
    }
    for (const item of items) {
      count +=
        countAuthInlineSecrets(item.auth) + countContractSpec(item) + countVariableSecrets(item);
      count += countPostmanBagInlineSecrets(getPostmanSidecar(item));
      if (rootOc === undefined) {
        // A `request` item's bag mirrors a typed node (http/graphql/grpc item or
        // SSE/MCP extension entry); a folder's bag is either a real OC folder or
        // an opaque placeholder, which the `info.type` probe tells apart.
        count += countOcBagInlineSecrets(
          (item as { _oc?: unknown })._oc,
          false,
          item.type === 'request'
        );
      }
      if (item.request) count += countRequestSecrets(item.request);
      if (item.items) walk(item.items, depth + 1);
    }
  };
  walk(collection.items, 0);
  return count;
}
