import { protocolSecretValueSchema } from '@shared/protocol/secret-value-schema';
import type { ZodType } from 'zod';

/**
 * SecretRef — discriminated union representing a secret value that may be
 * stored inline (plaintext) or referenced indirectly via a handle that the
 * main process resolves out of an OS-keychain-backed store.
 *
 * Why:
 *  - Inline plaintext in renderer state leaks via DevTools, log redactors,
 *    collection export, error reports, and prompt-injected scripts.
 *  - On the desktop build we have an OS keychain (macOS Keychain / Windows
 *    Credential Manager / libsecret) wrapping an encrypted electron-store
 *    via `safeStorage`. Secrets stored there never cross IPC back to the
 *    renderer — the main process resolves them in-process before the
 *    auth-signer step and discards the plaintext after the request flushes.
 *  - On the web build, there is no OS keychain, so `kind: 'inline'` is the
 *    only option. The threat model is documented in the security ADR.
 *
 * This module is the renderer-safe surface — types + predicates + a sync
 * `unwrapSecret()` helper for renderer code that needs the inline value.
 * Main-process resolution lives in `electron/main/security/secret-handle-store.ts`
 * and is invoked at the IPC boundary, never via IPC back to the renderer.
 *
 * `AuthConfig`'s sensitive fields are typed as `SecretValue` (widened from
 * the legacy `string`; see `secretRef-migrations.ts` for the store migration).
 * New auth descriptors should accept `SecretValue` from the start.
 */

/** A reference to a secret value — inline plaintext or an opaque handle. */
export type SecretRef =
  | {
      /** Plaintext value, stored in the renderer (and exported, and logged). */
      kind: 'inline';
      value: string;
    }
  | {
      /**
       * Opaque handle resolved in the main process. The id is a UUID that
       * keys into the encrypted secret store; the renderer should never
       * persist anything other than the handle and a label.
       */
      kind: 'handle';
      id: string;
      /** Optional UI label so the renderer can render "AWS prod key" without resolving. */
      label?: string;
    };

/** Anything that could carry a secret — either plain text or a typed SecretRef. */
export type SecretValue = string | SecretRef;

/** Type guard: is this a handle reference (vs. inline / plain string)? */
export function isSecretHandle(
  value: SecretValue | undefined
): value is { kind: 'handle'; id: string; label?: string } {
  return (
    value !== undefined &&
    typeof value === 'object' &&
    value !== null &&
    (value as SecretRef).kind === 'handle'
  );
}

/** Type guard: is this an inline SecretRef wrapper? */
export function isInlineSecretRef(
  value: SecretValue | undefined
): value is { kind: 'inline'; value: string } {
  return (
    value !== undefined &&
    typeof value === 'object' &&
    value !== null &&
    (value as SecretRef).kind === 'inline'
  );
}

/**
 * Sentinel placeholder returned by `unwrapSecret()` when a handle is
 * encountered in the renderer. Useful for UI rendering ("****") but MUST NOT
 * cross the IPC boundary or land on the wire — main-process handlers resolve
 * handles before constructing the outgoing request.
 */
export const SECRET_HANDLE_PLACEHOLDER = '••••••••';

/**
 * Renderer-safe unwrap: returns plaintext for inline values, the masked
 * placeholder for handles. Main-process callers MUST NOT use this — they
 * should call `resolveSecretHandle()` from `electron/main/security/secret-handle-store`
 * to obtain the real value before signing.
 *
 * Accepts plain strings too, for callers that haven't migrated yet.
 */
export function unwrapSecret(value: SecretValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value.kind === 'inline') return value.value;
  return SECRET_HANDLE_PLACEHOLDER;
}

/**
 * Returns a stable, masked summary for UI display — never leaks plaintext.
 * Used in auth-descriptor pickers and logs.
 */
export function describeSecret(value: SecretValue | undefined): string {
  if (value === undefined) return '(empty)';
  if (typeof value === 'string') return value.length === 0 ? '(empty)' : SECRET_HANDLE_PLACEHOLDER;
  if (value.kind === 'inline')
    return value.value.length === 0 ? '(empty)' : SECRET_HANDLE_PLACEHOLDER;
  return value.label ? `Handle: ${value.label}` : `Handle: ${value.id.slice(0, 8)}…`;
}

/**
 * Strip plaintext from a SecretValue before it crosses a boundary where
 * leakage matters (export, logging, agent-readable surface). Returns a
 * sanitised representation that's safe to render or persist alongside
 * non-secret data:
 *  - inline → empty inline (preserves shape, drops value)
 *  - handle → handle (already opaque)
 *  - string → empty string
 *
 * Use this in exporters, log redactors, and the MCP server's
 * tool-input/output payloads.
 */
export function redactSecret(value: SecretValue | undefined): SecretValue {
  if (value === undefined) return '';
  if (typeof value === 'string') return '';
  if (value.kind === 'inline') return { kind: 'inline', value: '' };
  return value;
}

/** Wrap a plain string into an inline SecretRef. Used at migration boundaries. */
export function inlineSecret(value: string): SecretRef {
  return { kind: 'inline', value };
}

/** Create a handle reference (renderer-side; the actual value lives in main). */
export function handleSecret(id: string, label?: string): SecretRef {
  return label !== undefined ? { kind: 'handle', id, label } : { kind: 'handle', id };
}

/**
 * Coerce an arbitrary persisted value into a canonical `SecretValue`:
 *  - string → `{kind:'inline', value}`
 *  - existing SecretRef → unchanged
 *  - anything else (undefined, number, malformed) → `{kind:'inline', value:''}`
 *
 * Used by Zustand store migrations to widen legacy plaintext fields without
 * data loss. Idempotent — safe to apply twice.
 */
export function coerceToInlineSecret(value: unknown): SecretValue {
  if (typeof value === 'string') return { kind: 'inline', value };
  if (isInlineSecretRef(value as SecretValue) || isSecretHandle(value as SecretValue)) {
    return value as SecretValue;
  }
  return { kind: 'inline', value: '' };
}

/**
 * Zod-style runtime guard for the SecretRef shape — used by IPC validators
 * and store-validators to gate persisted state. Returns the value unchanged
 * if valid; throws otherwise.
 */
export function assertSecretValue(value: unknown, fieldName: string): asserts value is SecretValue {
  if (typeof value === 'string') return;
  if (value && typeof value === 'object') {
    const v = value as { kind?: unknown; value?: unknown; id?: unknown };
    if (v.kind === 'inline' && typeof v.value === 'string') return;
    if (v.kind === 'handle' && typeof v.id === 'string') return;
  }
  throw new TypeError(`${fieldName}: expected string or SecretRef, got ${JSON.stringify(value)}`);
}

/**
 * Zod schema for SecretValue — re-exported from `shared/protocol/` so the
 * renderer, the Worker, and Electron's IPC validators all parse against the
 * same single source of truth.
 */
export const secretValueSchema = protocolSecretValueSchema as unknown as ZodType<SecretValue>;
