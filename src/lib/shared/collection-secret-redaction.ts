import type { AuthConfig, Collection, CollectionItem } from '@/types';
import {
  isSecretHandle,
  redactSecret,
  unwrapSecret,
  type SecretValue,
} from '@/lib/shared/secretRef';
import { SECRET_FIELDS_BY_AUTH_BLOCK } from '@/lib/shared/auth-secret-fields';

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
 * (`electron/main/collection-export-redactor.ts`) implements the same policy
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

function redactItem(item: CollectionItem): CollectionItem {
  const next: CollectionItem = { ...item };
  // Drop the OpenCollection passthrough bag — it holds the verbatim imported
  // node (including any plaintext auth from the source document), and the OC
  // exporter emits `_oc` verbatim when present. Keeping it would pipe the
  // original secrets straight through a "redacted" export. Cost: a redacted
  // OC export rebuilds from the redacted internal model instead of being
  // byte-stable — acceptable on the share-safely path.
  delete (next as { _oc?: unknown })._oc;
  if (next.auth) next.auth = redactAuthConfigSecrets(next.auth);
  if (next.items) next.items = next.items.map(redactItem);
  if (next.request && 'auth' in next.request) {
    next.request = {
      ...next.request,
      auth: redactAuthConfigSecrets(next.request.auth),
    } as typeof next.request;
  }
  return next;
}

/**
 * Returns a copy of the collection with every inline secret blanked —
 * collection-level auth, folder-level auth, and each request's auth.
 * Handle references are preserved. The original is not mutated.
 *
 * OpenCollection `_oc` passthrough bags are dropped at every level: they
 * contain the verbatim (pre-redaction) imported document, which the OC
 * exporter would otherwise emit as-is, leaking the very secrets this
 * function blanks.
 */
export function redactCollectionSecrets(collection: Collection): Collection {
  const next: Collection = {
    ...collection,
    ...(collection.auth ? { auth: redactAuthConfigSecrets(collection.auth) } : {}),
    items: collection.items.map(redactItem),
  };
  delete (next as { _oc?: unknown })._oc;
  return next;
}

/**
 * Counts non-empty inline (plaintext) secrets across the collection's auth
 * configs. Used by the export flow to decide whether to warn the user before
 * writing plaintext credentials into an export file. Handle references don't
 * count — they never expose plaintext.
 */
export function countCollectionInlineSecrets(collection: Collection): number {
  let count = countAuthInlineSecrets(collection.auth);
  const walk = (items: CollectionItem[]) => {
    for (const item of items) {
      count += countAuthInlineSecrets(item.auth);
      if (item.request && 'auth' in item.request) {
        count += countAuthInlineSecrets(item.request.auth);
      }
      if (item.items) walk(item.items);
    }
  };
  walk(collection.items);
  return count;
}
