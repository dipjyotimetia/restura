/**
 * Redacts secret-bearing fields from `AuthConfig` objects before they're
 * written to disk for collection export. Without this, a plaintext bearer
 * token / API key / AWS secret key etc. would land in the YAML file the user
 * shares with a teammate, commits to git, or copies into a chat tool.
 *
 * Strategy:
 *  - Inline plaintext (`string` or `{ kind: 'inline', value }`) → empty.
 *  - Handle references (`{ kind: 'handle', id }`) → preserved. The handle id
 *    is opaque on its own; same-machine re-import resolves it back to the
 *    correct secret, while a different machine just sees an unresolvable
 *    handle and prompts the user to re-enter (failing closed, not open).
 *
 * Works on `unknown` because the collection-manager stores auth as `unknown`
 * — it doesn't depend on the renderer's `AuthConfig` type at compile time.
 * If a field's shape doesn't match what we expect, we return the original
 * value unchanged rather than throwing — a partially-redacted export is
 * better than no export at all, but the caller should still surface a
 * warning when this happens.
 */

import type { SecretValue } from '../../../src/lib/shared/secretRef';
import { SECRET_FIELDS_BY_AUTH_BLOCK } from '../../../src/lib/shared/auth-secret-fields';

// Single source of truth shared with the renderer-side export redactor
// (`src/lib/shared/collection-secret-redaction.ts`) — a field added there is
// redacted here too. Widened to a string-keyed record because this module
// works on untyped auth blobs.
const SECRET_FIELDS_BY_AUTH_TYPE: Record<string, readonly string[]> = SECRET_FIELDS_BY_AUTH_BLOCK;

function redactSecretValue(value: unknown): SecretValue {
  if (typeof value === 'string') return '';
  if (value && typeof value === 'object') {
    const v = value as { kind?: unknown; value?: unknown; id?: unknown; label?: unknown };
    if (v.kind === 'inline') return { kind: 'inline', value: '' };
    if (v.kind === 'handle' && typeof v.id === 'string') {
      return typeof v.label === 'string'
        ? { kind: 'handle', id: v.id, label: v.label }
        : { kind: 'handle', id: v.id };
    }
  }
  return '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns a copy of `auth` with every known secret-bearing field redacted.
 * Non-secret fields (`username`, `region`, `service`, `key` name, URLs,
 * scopes, etc.) are preserved verbatim so the import round-trip reconstructs
 * the auth shape correctly — only the credential material is dropped.
 *
 * Copy depth note: the top-level object and each auth-block (e.g. `oauth2`)
 * are shallow-copied via spread. Nested objects/arrays inside an auth-block
 * (e.g. `oauth2.scopes: string[]`) share their reference with the input. The
 * sole caller (collection-manager export) serialises immediately to YAML and
 * does not mutate the result, so this is safe. If a future caller needs a
 * fully detached copy, replace `{ ...block }` with `structuredClone(block)`.
 */
export function redactAuthForExport(auth: unknown): unknown {
  if (!isPlainObject(auth)) return auth;

  const out: Record<string, unknown> = { ...auth };

  for (const [authType, secretFields] of Object.entries(SECRET_FIELDS_BY_AUTH_TYPE)) {
    const block = out[authType];
    if (!isPlainObject(block)) continue;
    const redactedBlock: Record<string, unknown> = { ...block };
    for (const field of secretFields) {
      if (field in redactedBlock) {
        redactedBlock[field] = redactSecretValue(redactedBlock[field]);
      }
    }
    out[authType] = redactedBlock;
  }

  return out;
}

/**
 * Blanks the value of any variable flagged `secret: true` before the
 * collection is written to disk. A credential stashed in a collection
 * variable must never leave the machine as plaintext — the recipient
 * re-enters it after import. Non-secret variables (base URLs, etc.) pass
 * through unchanged so the shared collection stays useful. The `secret` flag
 * is preserved so the variable still reads as secret on re-import. Mirrors the
 * renderer-side OpenCollection export, which emits secret variables as the
 * value-less `secretVariable` shape.
 */
export function redactSecretVariablesForExport<T extends { secret?: boolean; value?: unknown }>(
  variables: readonly T[] | undefined
): T[] | undefined {
  if (!variables) return undefined;
  return variables.map((v) => (v.secret ? { ...v, value: '' } : { ...v }));
}

/**
 * True iff the auth descriptor contains at least one plaintext secret that
 * `redactAuthForExport` will drop. Callers use this to surface a per-export
 * warning so the user knows the imported collection will be missing those
 * credentials and needs to re-enter them.
 */
export function authHasPlaintextSecret(auth: unknown): boolean {
  if (!isPlainObject(auth)) return false;
  for (const [authType, secretFields] of Object.entries(SECRET_FIELDS_BY_AUTH_TYPE)) {
    const block = auth[authType];
    if (!isPlainObject(block)) continue;
    for (const field of secretFields) {
      const value = block[field];
      if (typeof value === 'string' && value.length > 0) return true;
      if (
        isPlainObject(value) &&
        value.kind === 'inline' &&
        typeof value.value === 'string' &&
        value.value.length > 0
      ) {
        return true;
      }
    }
  }
  return false;
}
