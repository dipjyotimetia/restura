/**
 * Main-process secret handle store.
 *
 * Purpose: when an auth descriptor carries a `SecretRef` with `kind: 'handle'`,
 * the renderer never sees the plaintext value. Instead, the handle id points
 * at this store, which is backed by electron-store + safeStorage (the same
 * encryption setup as the credential store — see store-handler.ts for the
 * key-management rationale).
 *
 * Lifecycle:
 *  1. The renderer asks main to store a new secret via the `secret:store` IPC.
 *     Main generates a UUID, writes the encrypted value, and returns the handle.
 *  2. The renderer persists only the handle in its Zustand store. No plaintext
 *     ever appears in Dexie / electron-store at this scope.
 *  3. When a request needs to be signed, a handler in main calls
 *     `resolveSecretHandle()` to read the plaintext, signs the wire bytes,
 *     and lets the plaintext go out of scope.
 *  4. The renderer can ask main to delete a handle via `secret:delete`.
 *
 * Security properties:
 *  - `secret:resolve` is intentionally NOT exposed via the preload IPC bridge.
 *    Only main-process modules can resolve handles. Adding it to the preload
 *    bridge would defeat the entire purpose of the pattern.
 *  - Handle ids are version-4 UUIDs, so guessing one is computationally
 *    infeasible. They're not secrets themselves but they shouldn't be logged
 *    either (the request-logger redacts them).
 *  - The encryption key lives in OS keychain via safeStorage; if the key
 *    cannot be retrieved, the store falls back to a 0o600 plaintext key file
 *    with a loud warning (matching the credential store's policy).
 */

import * as crypto from 'crypto';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { assertTrustedSender } from '../ipc/ipc-validators';
import { getOrCreateEncryptedKey } from './encrypted-key';

// electron-store v9+ is ESM-only; require() returns the module namespace under Node 22+
const Store = require('electron-store').default;

interface HandleRecord {
  value: string;
  label?: string;
  createdAt: number;
  /** Optional namespace — lets the MCP server filter resolvable handles by tool/collection. */
  scope?: string;
}

export interface SecretStoreShape {
  get: (key: string) => HandleRecord | undefined;
  set: (key: string, value: HandleRecord) => void;
  delete: (key: string) => void;
  clear: () => void;
  has: (key: string) => boolean;
  store: Record<string, HandleRecord>;
}

let storeInstance: SecretStoreShape | null = null;

/**
 * Test-only seam: vitest's `vi.mock` cannot intercept the lazy CJS
 * `require('electron-store')` in getStore(), so unit tests inject an
 * in-memory store here instead. Never called in production code.
 */
export function __setSecretStoreForTests(store: SecretStoreShape | null): void {
  storeInstance = store;
}

function getStore(): SecretStoreShape {
  if (storeInstance) return storeInstance;
  storeInstance = new Store({
    name: 'restura-secret-handles',
    encryptionKey: getOrCreateEncryptedKey({
      fileName: '.secret-handles-key',
      storeLabel: 'secret-handle store',
    }),
    clearInvalidConfig: true,
  }) as SecretStoreShape;
  return storeInstance;
}

// ---------------------------------------------------------------------------
// Public API (main-process only)
// ---------------------------------------------------------------------------

/**
 * Create or update a secret handle. If `id` is omitted, a new UUID is generated.
 * Returns the handle id — the renderer should round-trip this through its
 * auth descriptor (`{ kind: 'handle', id }`) but never the plaintext.
 */
export function storeSecretHandle(args: {
  id?: string;
  value: string;
  label?: string;
  scope?: string;
}): { id: string } {
  const id = args.id ?? crypto.randomUUID();
  const record: HandleRecord = {
    value: args.value,
    createdAt: Date.now(),
    ...(args.label !== undefined ? { label: args.label } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
  };
  getStore().set(id, record);
  return { id };
}

/**
 * Resolve a handle to its plaintext value. Main-process only — DO NOT
 * surface this via the preload bridge.
 */
export function resolveSecretHandle(id: string): string | undefined {
  const record = getStore().get(id);
  return record?.value;
}

/** Delete a handle. Idempotent — silent if the id is unknown. */
export function deleteSecretHandle(id: string): void {
  getStore().delete(id);
}

/** Read-only metadata about a handle. Plaintext is never returned. */
export function describeSecretHandle(
  id: string
): { label?: string; scope?: string; createdAt: number } | undefined {
  const record = getStore().get(id);
  if (!record) return undefined;
  return {
    ...(record.label !== undefined ? { label: record.label } : {}),
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    createdAt: record.createdAt,
  };
}

/** List all known handles (metadata only). Used by the Settings UI. */
export function listSecretHandles(): Array<{
  id: string;
  label?: string;
  scope?: string;
  createdAt: number;
}> {
  const all = getStore().store;
  return Object.entries(all).map(([id, record]) => ({
    id,
    ...(record.label !== undefined ? { label: record.label } : {}),
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    createdAt: record.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// IPC registration — renderer-callable channels
// ---------------------------------------------------------------------------

const StoreInputSchema = z.object({
  value: z
    .string()
    .min(1)
    .max(64 * 1024),
  label: z.string().max(256).optional(),
  scope: z.string().max(128).optional(),
  // Optional id allows the renderer to update an existing handle in place.
  id: z.uuid().optional(),
});

const HandleIdSchema = z.object({
  id: z.uuid(),
});

// Generous budget: the SecretRef import migration
// (src/lib/shared/secretRef-migrations.ts) stores one handle per sensitive
// auth field in a tight loop when converting an imported collection, so a
// legitimate burst can be large. 600/min still bounds a runaway renderer.
export const secretRateLimiter = createKeyedRateLimiter(600, 60_000);

/**
 * Register one secret channel with the shared IPC policy stack: keyed rate
 * limit → trusted-sender check → Zod validation. Unlike
 * `createValidatedHandler` (which rejects the invoke on invalid input), this
 * surface's renderer contract returns `{ ok: false, error }` for validation
 * failures — the preload bridge types and call sites in SecretInput /
 * SettingsDrawer / secretRef-migrations branch on `result.ok` rather than
 * catching rejections, so that shape is preserved here.
 */
function handleSecretChannel<TInput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  impl: (input: TInput) => Record<string, unknown>
): void {
  ipcMain.handle(
    channel,
    rateLimited(secretRateLimiter, (event, payload: unknown) => {
      assertTrustedSender(channel, event);
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }
      return impl(parsed.data);
    })
  );
}

/**
 * Register IPC handlers. NOTE: `secret:resolve` is deliberately absent here —
 * resolution is a main-process-only operation. The renderer can never read
 * plaintext back out of the store.
 *
 * The describe surface is split across two channels (one + many) rather than
 * a single channel whose return shape varies by input — the latter discriminates
 * by key presence (`handle` vs `handles`), which is awkward to type-narrow on
 * the renderer side.
 */
export function registerSecretHandleIPC(): void {
  handleSecretChannel(IPC.secret.store, StoreInputSchema, (args) => {
    const { id } = storeSecretHandle({
      value: args.value,
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.scope !== undefined ? { scope: args.scope } : {}),
      ...(args.id !== undefined ? { id: args.id } : {}),
    });
    return { ok: true, id };
  });

  handleSecretChannel(IPC.secret.delete, HandleIdSchema, ({ id }) => {
    deleteSecretHandle(id);
    return { ok: true };
  });

  handleSecretChannel(IPC.secret.describe, HandleIdSchema, ({ id }) => {
    const desc = describeSecretHandle(id);
    return { ok: true, handle: desc ?? null };
  });

  // `list` takes no payload — the renderer invokes with zero args, which
  // arrives here as `undefined`.
  handleSecretChannel(IPC.secret.list, z.undefined(), () => {
    return { ok: true, handles: listSecretHandles() };
  });
}

/** Tear down IPC handlers; idempotent. */
export function unregisterSecretHandleIPC(): void {
  ipcMain.removeHandler('secret:store');
  ipcMain.removeHandler('secret:delete');
  ipcMain.removeHandler('secret:describe');
  ipcMain.removeHandler('secret:list');
}

// ---------------------------------------------------------------------------
// Helper for IPC handlers in other modules
// ---------------------------------------------------------------------------

/**
 * Resolve a `SecretRef`-shaped value to plaintext. Accepts:
 *  - a plain string (returned as-is, for compatibility with legacy auth descriptors)
 *  - `{ kind: 'inline', value }` (returns .value)
 *  - `{ kind: 'handle', id }` (resolves through the store)
 *
 * Returns undefined if the handle is unknown — callers should treat that
 * as "secret missing" and fail the request explicitly rather than sending
 * an empty string.
 */
export function unwrapSecretValueMain(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const v = value as { kind?: unknown; value?: unknown; id?: unknown };
    if (v.kind === 'inline' && typeof v.value === 'string') return v.value;
    if (v.kind === 'handle' && typeof v.id === 'string') {
      return resolveSecretHandle(v.id);
    }
  }
  return undefined;
}
