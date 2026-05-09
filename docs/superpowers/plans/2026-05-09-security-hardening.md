# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four security gaps identified in the architectural review on 2026-05-08: (a) replace the TOFU encryption key (random key stored next to the ciphertext) with hardware-backed `safeStorage` on Electron and an honest session-passphrase model on web; (b) make request-shape validation strict (`validateRequestUpdate` currently logs and applies invalid updates); (c) delete the `dangerousPatterns` regex in `scriptExecutor.ts` that pretends to add security on top of an already-sandboxed QuickJS VM; (d) move AWS SigV4 (and other auth-that-needs-the-exact-wire-bytes) into the Worker / Electron fetcher so signing happens against the bytes the upstream actually sees, not against a renderer-side reconstruction that a Worker mutation can break.

**Architecture:** Encryption keys flow through a small `KeyProvider` interface in `src/lib/shared/`. Three implementations: `ElectronSafeStorageKeyProvider` (uses `electron.safeStorage` IPC), `WebSessionPassphraseProvider` (in-memory, set via a passphrase prompt on app load — fallback to "no encryption" with a clear UI banner), `EphemeralKeyProvider` (existing TOFU behaviour, retained for backward compat with the documented warning). Auth signing moves to a new `shared/protocol/auth-signer.ts` module consumed by both worker and electron fetchers — renderer passes `RequestSpec.auth` (not headers); the fetcher signs immediately before sending. Strict validation in the store hard-fails and surfaces a toast.

**Tech Stack:** Electron `safeStorage` (built-in), `@aws-sdk/signature-v4` (new dep — small, Node + browser compat) OR keep the existing hand-rolled SigV4 in `src/features/http/lib/awsSigV4.ts` and move it to `shared/protocol/`. Existing `sonner` toast library for validation errors. No other new deps.

---

## File structure

**Created:**
- `src/lib/shared/keyProvider.ts` — `KeyProvider` interface + three implementations (Electron, Web passphrase, Ephemeral)
- `src/lib/shared/keyProvider.test.ts`
- `src/components/shared/PassphrasePrompt.tsx` — modal that appears on first load if no in-memory key
- `shared/protocol/auth-signer.ts` — moved from `src/features/http/lib/awsSigV4.ts` + adapted for backend use
- `shared/protocol/auth-signer.test.ts`
- `electron/main/key-store.ts` — IPC handlers for `safeStorage.encryptString` / `decryptString` operations
- `docs/adr/0004-security-hardening.md`

**Modified:**
- `src/lib/shared/dexie-storage.ts` — replace `getEncryptionKey()` with `KeyProvider.getKey()`
- `src/lib/shared/encryption.ts` — accept a `KeyProvider` instead of inline key constant
- `src/lib/shared/encrypted-storage.ts` — same
- `src/lib/shared/secure-storage.ts` (Electron) — route through `safeStorage` IPC
- `src/store/useRequestStore.ts` — `updateRequest` hard-fails on validation error, calls `toast.error`
- `src/features/scripts/lib/scriptExecutor.ts` — DELETE the `dangerousPatterns` regex block (~lines 588-606) + add explanatory comment
- `src/features/scripts/lib/__tests__/scriptExecutor.test.ts` — update tests that asserted the regex behaviour
- `src/features/http/lib/applyAuthHeaders.ts` — keep for non-SigV4 auth; route SigV4 to `auth-signer` via the fetcher
- `worker/handlers/proxy.ts` — call `auth-signer.sign()` before sending when `spec.auth.type === 'aws-signature'`
- `electron/main/http-handler.ts` — same
- `electron/main/preload.ts` — expose `safeStorage` IPC: `secureKey.set(key, value)`, `secureKey.get(key)`, `secureKey.has(key)`
- `electron/types/electron.d.ts` — type the new `secureKey` IPC surface
- `src/lib/shared/platform.ts` — expose `electronAPI.secureKey`
- `src/components/shared/ProxySettings.tsx` (or wherever mTLS/CA/SOCKS settings live) — add a "Desktop only" badge on fields that don't apply to web
- `docs/ARCHITECTURE.md` — update the Storage section: explicit web-vs-desktop encryption guarantees; add Auth-at-the-wire description; note desktop-only features
- `README.md` — update the security claim (currently says "encrypted at rest"; clarify the web-vs-desktop nuance)

**Deleted:**
- The `dangerousPatterns` regex block in `src/features/scripts/lib/scriptExecutor.ts` (security theatre)

---

## Tasks

### Task 1: Define `KeyProvider` interface + three implementations

**Files:**
- Create: `src/lib/shared/keyProvider.ts`
- Create: `src/lib/shared/keyProvider.test.ts`

The provider abstracts "where does the encryption key come from" so consumers (`dexie-storage.ts`, `encrypted-storage.ts`) don't care about the platform. The active provider is selected at module load based on `isElectron()`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EphemeralKeyProvider,
  WebSessionPassphraseProvider,
  ElectronSafeStorageKeyProvider,
} from './keyProvider';

describe('EphemeralKeyProvider', () => {
  it('returns the same generated key across calls within a session', async () => {
    const p = new EphemeralKeyProvider();
    const a = await p.getKey();
    const b = await p.getKey();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(32);
  });

  it('isHardwareBacked returns false', () => {
    expect(new EphemeralKeyProvider().isHardwareBacked).toBe(false);
  });
});

describe('WebSessionPassphraseProvider', () => {
  beforeEach(() => {
    WebSessionPassphraseProvider.reset();
  });

  it('throws if no passphrase has been set', async () => {
    const p = new WebSessionPassphraseProvider();
    await expect(p.getKey()).rejects.toThrow(/passphrase/i);
  });

  it('returns a derived key after setPassphrase', async () => {
    const p = new WebSessionPassphraseProvider();
    await p.setPassphrase('correct horse battery staple');
    const key = await p.getKey();
    expect(key).toBeTruthy();
  });

  it('two providers with same passphrase derive the same key (deterministic)', async () => {
    const p1 = new WebSessionPassphraseProvider();
    await p1.setPassphrase('hunter2');
    const k1 = await p1.getKey();
    WebSessionPassphraseProvider.reset();
    const p2 = new WebSessionPassphraseProvider();
    await p2.setPassphrase('hunter2');
    const k2 = await p2.getKey();
    expect(k1).toBe(k2);
  });

  it('isHardwareBacked returns false', () => {
    expect(new WebSessionPassphraseProvider().isHardwareBacked).toBe(false);
  });
});

describe('ElectronSafeStorageKeyProvider', () => {
  it('calls the secureKey IPC to fetch / generate the key', async () => {
    const get = vi.fn().mockResolvedValue('persisted-key');
    const has = vi.fn().mockResolvedValue(true);
    const set = vi.fn();
    const p = new ElectronSafeStorageKeyProvider({ get, set, has });
    const k = await p.getKey();
    expect(k).toBe('persisted-key');
    expect(get).toHaveBeenCalledWith('restura-encryption-key');
  });

  it('generates and stores a new key on first run', async () => {
    const get = vi.fn();
    const has = vi.fn().mockResolvedValue(false);
    const set = vi.fn();
    const p = new ElectronSafeStorageKeyProvider({ get, set, has });
    const k = await p.getKey();
    expect(k.length).toBeGreaterThan(32);
    expect(set).toHaveBeenCalledWith('restura-encryption-key', k);
  });

  it('isHardwareBacked returns true', () => {
    const p = new ElectronSafeStorageKeyProvider({
      get: vi.fn(), set: vi.fn(), has: vi.fn(),
    });
    expect(p.isHardwareBacked).toBe(true);
  });
});
```

- [ ] **Step 2: Implement `keyProvider.ts`**

```ts
import { generateLocalEncryptionKey } from './encryption';

export interface KeyProvider {
  getKey(): Promise<string>;
  /** True if the key is protected by OS-level secure storage (keychain, libsecret, etc). */
  readonly isHardwareBacked: boolean;
  /** Optional human-readable label for the UI (e.g. "macOS Keychain", "Session passphrase"). */
  readonly label: string;
}

/**
 * Default fallback. Generates a random key on first use and keeps it in memory
 * (and in the metadata table). Equivalent to the pre-Plan-3 behaviour. NOT
 * hardware-backed — anyone with disk access can decrypt. Use only when no
 * better provider is available (tests, dev-mode).
 */
export class EphemeralKeyProvider implements KeyProvider {
  readonly isHardwareBacked = false;
  readonly label = 'Ephemeral (in-memory)';
  private cached: string | null = null;

  async getKey(): Promise<string> {
    if (this.cached === null) this.cached = generateLocalEncryptionKey();
    return this.cached;
  }
}

/**
 * Web provider that derives the key from a user-supplied passphrase via PBKDF2.
 * The key lives in memory only; on a fresh page load the user re-enters the
 * passphrase or proceeds without encryption.
 */
export class WebSessionPassphraseProvider implements KeyProvider {
  readonly isHardwareBacked = false;
  readonly label = 'Session passphrase';
  private static singletonKey: string | null = null;

  static reset(): void {
    WebSessionPassphraseProvider.singletonKey = null;
  }

  async setPassphrase(passphrase: string): Promise<void> {
    if (!passphrase) throw new Error('Passphrase must not be empty');
    // Deterministic derivation so re-entering the same passphrase yields the same key.
    // Salt is constant per app to keep the contract simple; rotating salt would require
    // re-encrypting the entire vault on every change.
    const SALT = new TextEncoder().encode('restura/v1/passphrase');
    const passBytes = new TextEncoder().encode(passphrase);
    const material = await crypto.subtle.importKey(
      'raw', passBytes, 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: SALT, iterations: 100_000, hash: 'SHA-256' },
      material,
      256
    );
    const hex = Array.from(new Uint8Array(bits))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    WebSessionPassphraseProvider.singletonKey = hex;
  }

  async getKey(): Promise<string> {
    if (WebSessionPassphraseProvider.singletonKey === null) {
      throw new Error('No passphrase set. Call setPassphrase first or use EphemeralKeyProvider.');
    }
    return WebSessionPassphraseProvider.singletonKey;
  }
}

export interface SecureKeyIpc {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

/**
 * Electron provider that persists the key via electron.safeStorage (keychain on
 * macOS, Credential Manager on Windows, libsecret on Linux). Hardware-backed.
 */
export class ElectronSafeStorageKeyProvider implements KeyProvider {
  readonly isHardwareBacked = true;
  readonly label = 'OS keychain';
  private cached: string | null = null;
  private storeKey = 'restura-encryption-key';

  constructor(private ipc: SecureKeyIpc) {}

  async getKey(): Promise<string> {
    if (this.cached !== null) return this.cached;
    const exists = await this.ipc.has(this.storeKey);
    if (exists) {
      const v = await this.ipc.get(this.storeKey);
      if (v) {
        this.cached = v;
        return v;
      }
    }
    const fresh = generateLocalEncryptionKey();
    await this.ipc.set(this.storeKey, fresh);
    this.cached = fresh;
    return fresh;
  }
}
```

- [ ] **Step 3: Run tests + commit**

```bash
cd /Users/dipjyotimetia/Documents/working/ccviews/restura
npm run test:run -- src/lib/shared/keyProvider 2>&1 | tail -10
git add src/lib/shared/keyProvider.ts src/lib/shared/keyProvider.test.ts
git commit -m "feat(security): add KeyProvider interface + 3 implementations"
```

---

### Task 2: Electron `safeStorage` IPC

**Files:**
- Create: `electron/main/key-store.ts` — IPC handlers
- Modify: `electron/main/main.ts` — register the handlers
- Modify: `electron/main/preload.ts` — expose `secureKey` API
- Modify: `electron/types/electron.d.ts` — type the API
- Modify: `src/lib/shared/platform.ts` — expose via `electronAPI.secureKey`

`electron.safeStorage` provides `encryptString(plaintext): Buffer` and `decryptString(buffer): string` backed by the OS keychain. The IPC stores the encrypted blob under a Dexie metadata key.

- [ ] **Step 1: Write `key-store.ts`**

```ts
import { ipcMain, safeStorage } from 'electron';
import Store from 'electron-store';

const store = new Store({ name: 'secure-keys', encryptionKey: undefined });

export function registerKeyStoreIpc(): void {
  ipcMain.handle('secureKey:get', async (_e, key: string) => {
    const blob = store.get(key) as string | undefined;
    if (!blob || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return undefined;
    }
  });
  ipcMain.handle('secureKey:set', async (_e, key: string, value: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption not available on this system');
    }
    const encrypted = safeStorage.encryptString(value);
    store.set(key, encrypted.toString('base64'));
  });
  ipcMain.handle('secureKey:has', async (_e, key: string) => {
    return store.has(key);
  });
}
```

- [ ] **Step 2: Wire into `main.ts`**

Find the existing IPC registration section. Add `registerKeyStoreIpc()`.

- [ ] **Step 3: Expose via `preload.ts`**

```ts
secureKey: {
  get: (key: string): Promise<string | undefined> => ipcRenderer.invoke('secureKey:get', key),
  set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('secureKey:set', key, value),
  has: (key: string): Promise<boolean> => ipcRenderer.invoke('secureKey:has', key),
},
```

- [ ] **Step 4: Type in `electron.d.ts`**

```ts
secureKey: {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<void>;
  has: (key: string) => Promise<boolean>;
};
```

- [ ] **Step 5: Wire `electronAPI.secureKey` accessor in `platform.ts`**

If `getElectronAPI()` returns the typed surface, `secureKey` is now part of it.

- [ ] **Step 6: Validate (electron tests)**

```bash
npm run test:run -- electron/main/__tests__/ 2>&1 | tail -10
npx tsc --noEmit -p electron/tsconfig.json 2>&1 | tail -3
```

- [ ] **Step 7: Commit**

```bash
git add electron/main/key-store.ts electron/main/main.ts electron/main/preload.ts \
        electron/types/electron.d.ts src/lib/shared/platform.ts
git commit -m "feat(electron): expose safeStorage-backed secureKey IPC"
```

---

### Task 3: Wire `KeyProvider` into `dexie-storage.ts` + `encryption.ts`

**Files:**
- Modify: `src/lib/shared/dexie-storage.ts` — call `keyProvider.getKey()` instead of `getEncryptionKey()`
- Modify: `src/lib/shared/encryption.ts` — keep existing functions; remove the inline metadata-table key dance (now done via the provider)

- [ ] **Step 1: Add a module-scope provider selector**

In `dexie-storage.ts`, replace the existing `getEncryptionKey()` function:

```ts
import { ElectronSafeStorageKeyProvider, EphemeralKeyProvider, WebSessionPassphraseProvider, type KeyProvider } from './keyProvider';
import { isElectron, getElectronAPI } from './platform';

let activeProvider: KeyProvider | null = null;

export function getKeyProvider(): KeyProvider {
  if (activeProvider) return activeProvider;
  if (isElectron()) {
    const api = getElectronAPI();
    if (api?.secureKey) {
      activeProvider = new ElectronSafeStorageKeyProvider(api.secureKey);
      return activeProvider;
    }
    activeProvider = new EphemeralKeyProvider();
    return activeProvider;
  }
  // Web default: ephemeral. Apps can switch to WebSessionPassphraseProvider via setKeyProvider.
  activeProvider = new EphemeralKeyProvider();
  return activeProvider;
}

export function setKeyProvider(provider: KeyProvider): void {
  activeProvider = provider;
}

async function getEncryptionKey(): Promise<string> {
  return getKeyProvider().getKey();
}
```

The existing `getEncryptionKey()` callers within the file keep working — they now route through the provider.

- [ ] **Step 2: Run validate**

```bash
npm run validate 2>&1 | tail -10
```

All clean. No new tests yet — Task 4 adds the integration test.

- [ ] **Step 3: Commit**

```bash
git add src/lib/shared/dexie-storage.ts
git commit -m "feat(security): route encryption key through KeyProvider"
```

---

### Task 4: Web passphrase prompt UI

**Files:**
- Create: `src/components/shared/PassphrasePrompt.tsx`
- Create: `src/components/shared/__tests__/PassphrasePrompt.test.tsx`
- Modify: `src/routes/index.tsx` — render the prompt on first load

A modal dialog that:
- Appears once on app load (web only)
- Two options: "Set a session passphrase" (input + confirm) OR "Continue without encryption (data stored in plaintext)"
- On passphrase set: calls `WebSessionPassphraseProvider.setPassphrase` and `setKeyProvider(provider)`
- On skip: leaves the `EphemeralKeyProvider` active and shows a small persistent banner: "⚠ Encryption is off — anyone with disk access can read your data. Set a passphrase in Settings."

Tests cover the two paths and that closing/dismissing without choice keeps the prompt alive.

- [ ] **Step 1-N: TDD as in earlier plans**

- [ ] **Step N: Commit**

```bash
git add src/components/shared/PassphrasePrompt.tsx src/components/shared/__tests__/PassphrasePrompt.test.tsx src/routes/index.tsx
git commit -m "feat(security): web passphrase prompt + 'no encryption' UI banner"
```

---

### Task 5: Strict request validation in store

**Files:**
- Modify: `src/store/useRequestStore.ts` — `updateRequest` hard-fails on validation
- Modify: `src/store/__tests__/useRequestStore.test.ts` — add hard-fail test

Currently `updateRequest` (around line 200-something after Plan 2's reshape) catches validation errors and applies the partial update anyway with a `console.error`. Replace with: do not apply, dispatch a `toast.error`, and emit a one-time `console.warn` with the offending field for debugging.

- [ ] **Step 1: Update the action**

```ts
import { toast } from 'sonner';
// ...
updateRequest: (updates) => {
  const state = get();
  if (!state.activeTabId) return;
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  if (!active) return;
  let next: Request;
  try {
    next = validateRequestUpdate(active.request, updates);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Invalid request update';
    console.warn('Request update rejected:', msg, updates);
    toast.error('Invalid input', { description: msg });
    return; // do NOT apply
  }
  set((s) => ({
    tabs: patchActiveTab(s, (t) => ({ ...t, request: next, isDirty: true })),
  }));
},
```

- [ ] **Step 2: Add a test**

```ts
it('rejects an update that fails validation; does not mutate the active tab', () => {
  useRequestStore.getState().openTab(makeHttp({ url: 'https://a.com' }));
  // updates with an invalid method should be rejected by validateRequestUpdate
  useRequestStore.getState().updateRequest({ method: 123 as unknown as 'GET' });
  const tab = useRequestStore.getState().getActiveTab()!;
  expect((tab.request as HttpRequest).url).toBe('https://a.com');
  expect((tab.request as HttpRequest).method).toBe('GET'); // unchanged
});
```

(The exact "invalid" shape depends on what `validateRequestUpdate` rejects — read the validator first.)

- [ ] **Step 3: Run + commit**

```bash
npm run validate
git add src/store/useRequestStore.ts src/store/__tests__/useRequestStore.test.ts
git commit -m "feat(security): updateRequest hard-fails validation; toast on error"
```

---

### Task 6: Drop `dangerousPatterns` regex from scriptExecutor

**Files:**
- Modify: `src/features/scripts/lib/scriptExecutor.ts`
- Modify: `src/features/scripts/lib/__tests__/scriptExecutor.test.ts` — drop tests asserting the regex

The regex (around lines 588-606 pre-Plan-3) tries to block `eval`, `Function(`, `__proto__`, `constructor[`, `Object.prototype` on the user's source string before QuickJS sees it. Inside the WASM-isolated QuickJS runtime, NONE of these are dangerous — there's no host bridge to escape. The regex is security theatre and breaks legitimate user code (`obj.constructor.name`, `Function.prototype.bind`, etc.).

- [ ] **Step 1: Delete the regex block**

Replace the block with:

```ts
// Note: no source-level pattern filter. The QuickJS runtime is the security
// boundary — it's WASM-isolated with no host bridge, so eval/Function/__proto__/
// constructor[]/Object.prototype inside the user script cannot reach any native
// API. A regex blocklist would only break legitimate code (Function.prototype.bind,
// obj.constructor.name, etc.) without adding security.
```

- [ ] **Step 2: Update tests**

Find tests that asserted `dangerousPatterns` rejected scripts (look for "blocked patterns" or test names mentioning dangerous patterns). Either delete them or convert to "the sandbox doesn't escape" tests — verify that running `eval('process.exit()')` inside QuickJS does NOT terminate the host (it'll throw because `process` doesn't exist in the sandbox).

- [ ] **Step 3: Run + commit**

```bash
npm run test:run -- src/features/scripts
git add src/features/scripts/lib/scriptExecutor.ts src/features/scripts/lib/__tests__/scriptExecutor.test.ts
git commit -m "chore(security): drop dangerousPatterns regex from scriptExecutor

The QuickJS WASM sandbox is the security boundary. The source-level
regex pretended to block eval/Function/__proto__/etc. but none of these
are dangerous inside the sandbox (no host bridge), and the regex broke
legitimate user code (Function.prototype.bind, obj.constructor.name).
Comment in the file explains why no source-level filter exists."
```

---

### Task 7: Move SigV4 to backend (auth-at-the-wire)

**Files:**
- Create: `shared/protocol/auth-signer.ts`
- Create: `shared/protocol/auth-signer.test.ts`
- Modify: `worker/handlers/proxy.ts` — sign before sending when auth.type === 'aws-signature'
- Modify: `electron/main/http-handler.ts` — same
- Modify: `src/features/http/lib/applyAuthHeaders.ts` — drop SigV4 (keep other auth types)
- Modify: `src/features/http/lib/requestExecutor.ts` — pass `request.auth` through to the proxy/IPC layer instead of pre-signing
- Modify: `worker/handlers/__tests__/proxy.test.ts` — add SigV4 sign-at-wire tests

The shared core's `RequestSpec` already accepts arbitrary headers but doesn't know about auth. Two design choices:
1. Add `RequestSpec.auth?: AuthConfig` and have `executeHttpProxy` apply auth headers via `auth-signer` before the fetcher call.
2. Keep `RequestSpec` auth-agnostic; have each backend's adapter sign before invoking `executeHttpProxy`.

Choice 1 centralises but couples the shared core to auth concepts. Choice 2 keeps the shared core pure but duplicates the signing call. Pick **choice 1** — auth is a request-level concern, not a transport concern, and SigV4 needs the final body bytes which the shared core builds.

- [ ] **Step 1: Move `awsSigV4.ts` content to `shared/protocol/auth-signer.ts`**

Read the existing `src/features/http/lib/awsSigV4.ts`. Copy the SigV4 implementation into `shared/protocol/auth-signer.ts`. The new module's public API:

```ts
import type { AuthConfig } from './types';

export interface SignedHeaders {
  headers: Record<string, string>;
}

/**
 * Apply auth headers (and signed query params, for some auth types) given the
 * exact request bytes about to hit the wire. Called by executeHttpProxy after
 * body construction and before the fetcher.
 */
export async function applyAuth(
  auth: AuthConfig | undefined,
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: BodyInit | undefined;
  }
): Promise<SignedHeaders>;
```

For SigV4: hash the request body (SHA-256 of the bytes), include in canonical request, derive the signing key from access-secret + region + service + date, compute the signature, return `Authorization` + `X-Amz-Date` + `X-Amz-Security-Token` (if session token) headers.

For Bearer / Basic / API-key / OAuth2: keep the existing simple header construction (already in `applyAuthHeaders.ts`).

- [ ] **Step 2: Add `auth?: AuthConfig` to `RequestSpec` in `shared/protocol/types.ts`**

```ts
export interface RequestSpec {
  // ... existing fields
  auth?: AuthConfig;  // applied by executeHttpProxy before fetcher call
}
```

- [ ] **Step 3: Wire into `executeHttpProxy`**

```ts
// After body building, before the fetcher call:
if (spec.auth && spec.auth.type !== 'none') {
  const signed = await applyAuth(spec.auth, {
    method,
    url: targetUrl.toString(),
    headers,
    body: finalBody,
  });
  Object.assign(headers, signed.headers);
}
```

- [ ] **Step 4: Same for `executeHttpProxyStreaming`**

- [ ] **Step 5: Renderer side — pass auth through, drop pre-signing**

In `src/features/http/lib/requestExecutor.ts`:
- Drop the `applyAuthHeaders` call for SigV4 — for other auth types, keep client-side header construction (they don't need wire-byte fidelity)
- Add `auth: request.auth` to the spec sent over IPC / to the worker

- [ ] **Step 6: Tests**

Add a SigV4 sign-at-wire test to `worker/handlers/__tests__/proxy.test.ts`:
- Mock the upstream, assert that the `Authorization` header on the upstream request matches the SigV4 signature computed from the EXACT body bytes the worker sent (not the renderer's reconstruction).

- [ ] **Step 7: Run + commit**

```bash
npm run validate
git add shared/protocol/auth-signer.ts shared/protocol/auth-signer.test.ts shared/protocol/http-proxy.ts shared/protocol/types.ts \
        worker/handlers/proxy.ts worker/handlers/__tests__/proxy.test.ts \
        electron/main/http-handler.ts \
        src/features/http/lib/applyAuthHeaders.ts src/features/http/lib/requestExecutor.ts
git commit -m "feat(security): SigV4 sign-at-wire (worker + electron)

Auth signing moves from the renderer to the shared protocol core,
which signs against the exact body bytes about to hit the upstream.
Renderer passes RequestSpec.auth through; executeHttpProxy applies
auth headers (via shared/protocol/auth-signer) after body construction
and before the fetcher call.

Other auth types (Bearer, Basic, API-key, OAuth2) keep client-side
header construction — they don't depend on wire-byte fidelity."
```

---

### Task 8: UI hints for desktop-only features + ARCHITECTURE.md

**Files:**
- Modify: `src/components/shared/ProxySettings.tsx` (or wherever mTLS / CA / SOCKS / system-proxy detection live)
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`

For each desktop-only field (mTLS upload, CA cert upload, SOCKS proxy type, PAC URL), add a small "Desktop only" badge when `isElectron()` is false. Hovering shows: "This feature is only available in the Electron desktop app. The web client cannot proxy through SOCKS, present client certificates, or load PAC files."

ARCHITECTURE.md gets an explicit "Web vs Desktop feature parity" subsection listing which capabilities differ.

README.md security claim updated: today says "encrypted at rest with AES-256-GCM" without nuance. Clarify: "Desktop encrypts via OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret); web requires a session passphrase or runs in plaintext mode with a clear UI banner."

- [ ] **Step 1-N: implement, commit**

```bash
git commit -m "docs(security): document web/desktop feature parity + UI hints"
```

---

### Task 9: ADR-0004 + final architecture pass

**Files:**
- Create: `docs/adr/0004-security-hardening.md`
- Modify: `docs/ARCHITECTURE.md` — add "Security model" section consolidating the changes

ADR captures:
- Why the old TOFU key was theatre (key next to ciphertext = no protection vs disk access)
- Why `safeStorage` on Electron + session passphrase on web is the correct asymmetric model (Electron has OS APIs the browser doesn't)
- Why deleting `dangerousPatterns` is a security upgrade (not a regression) — sandbox is the boundary, source filter blocks legitimate code
- Why auth-at-the-wire matters (SigV4 signs body bytes; intermediate transformations break signatures)
- The deferred items: web SigV4 parity (now done), desktop-only feature documentation (now done)

- [ ] **Step 1-N: write, commit**

---

## Self-review checklist

- [ ] `rg -n "dangerousPatterns" src/features/scripts/` returns no matches
- [ ] `rg -n "getEncryptionKey" src/lib/shared/` only matches inside `keyProvider.ts` or `dexie-storage.ts`
- [ ] On Electron, the encryption key persists across app restarts via `safeStorage` (manual smoke test)
- [ ] On web, the passphrase prompt appears on first load; setting a passphrase encrypts the next save; refusing shows the plaintext banner
- [ ] `updateRequest` with an invalid update does NOT mutate the active tab and surfaces a toast
- [ ] AWS SigV4 requests show the correct `Authorization` header generated from the exact body bytes the upstream receives (manual test against e.g. an AWS S3 bucket)
- [ ] `npm run validate` passes
- [ ] mTLS / CA / SOCKS / PAC fields show "Desktop only" badge in the web client

---

## Out of scope (future plans)

- **Per-request encryption keys** (e.g., separate vaults per environment): wider rework; not needed for Plan 3's threat model
- **End-to-end encryption between desktop and a sync server**: belongs to the deferred sync/collaboration roadmap
- **2FA on the passphrase**: out of scope; web users who want stronger protection can use the desktop app
- **Automatic detection of leaked secrets in script output**: separate feature
