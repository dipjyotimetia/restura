# Security design

This is the design-level companion to the two operational security docs:

- [`docs/security.md`](./security.md) — storage-encryption **policy** and the SSRF / DNS-rebind tiers.
- The website's **Security model** page — a platform-by-platform overview.

It explains the _why_ behind the posture — the threat model, the trust
boundaries, and the design of the parts that are easy to get subtly wrong:
secret storage, the OS keychain, code signing, and the secret-resolution path.
Decisions referenced here are recorded in
[ADR 0004](./adr/0004-security-hardening.md),
[0006](./adr/0006-electron-connection-and-dns-hardening.md), and
[0007](./adr/0007-secret-ref-pattern.md).

## Threat model

Restura is a developer tool that sends arbitrary, user-authored requests to
arbitrary endpoints. That shapes what we defend against and what we explicitly
do not.

**In scope:**

- **Secret exposure at rest** — credentials, tokens, and keys must not sit in
  plaintext on disk, in exported collections, in logs, or on the
  agent-readable MCP surface.
- **Secret exposure in the renderer** — a compromised or buggy renderer (XSS in
  a rendered response, a malicious collection) must not be able to read
  plaintext secrets back out.
- **SSRF** — a request (or a shared collection, or a redirect) must not be able
  to reach internal/cloud-metadata addresses through our proxy.
- **Untrusted script execution** — pre-request/test scripts ride along in
  shared collections and are effectively untrusted code.
- **Supply-chain integrity of the desktop app** — installs and updates must be
  signed and notarised so the binary that runs is the one we shipped.

**Out of scope (documented, not silently ignored):**

- A fully compromised OS/user account — if the attacker is the logged-in user,
  the OS keychain unlocks for them too.
- True DNS-rebind at TTL=0 for the transports that can't pin the connect
  address (see [`docs/security.md`](./security.md#ssrf--dns-rebind-guard-electron)).
- Web at-rest encryption by default — the browser sandbox can't reach an OS
  keychain; see "Platform asymmetry" below.

## Trust boundaries

```
 ┌──────────────────────────── renderer (untrusted-ish) ────────────────────────────┐
 │  React SPA · Zustand state · QuickJS script sandbox                                │
 │  sees: SecretRef HANDLES, redacted context — never plaintext secrets              │
 └───────────────▲───────────────────────────────────────────────▲──────────────────┘
                 │ contextBridge IPC (validated, frame-checked)    │ fetch /api/*
 ┌───────────────┴──────────── Electron main (trusted) ────────────┴──────────────────┐
 │  protocol handlers · auth signing · secret resolution · safeStorage / OS keychain   │
 └─────────────────────────────────────────────────────────────────────────────────────┘
                 │                                                  │
          OS keychain                                        upstream (SSRF-guarded)
```

The renderer is treated as the **lower-trust** side of the IPC boundary.
Everything that touches a plaintext secret — resolution, wire-signing — happens
in main. Crossing back into the renderer is the thing we design to prevent.

## Defense in depth

| Layer              | Mechanism                                                                              | Source                                                                           |
| ------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Process isolation  | `contextIsolation`, `sandbox`, `nodeIntegration:false`, `webSecurity`                  | `electron/main/window-manager.ts`                                                |
| IPC boundary       | `assertTrustedSender` frame allow-list + Zod validation + per-`webContents` rate limit | `electron/main/ipc-validators.ts`                                                |
| Content policy     | Production CSP: no remote `script-src`, `frame-ancestors 'none'`                       | `electron/main/main.ts`                                                          |
| Secret isolation   | `SecretRef` handles; no `secret:resolve` in preload                                    | `electron/main/secret-handle-store.ts`                                           |
| At-rest encryption | electron-store + 256-bit key wrapped by OS keychain (`safeStorage`)                    | `electron/main/encrypted-key.ts`                                                 |
| SSRF / DNS         | shared URL validation + pinned/pre-flight DNS guard                                    | `shared/protocol/url-validation.ts`, `electron/main/dns-guard.ts`                |
| Wire-level auth    | AWS SigV4 / OAuth1 / WSSE signed in main, not renderer                                 | `shared/protocol/auth-signer.ts`                                                 |
| Script sandbox     | QuickJS WASM, no DOM/fs/network, memory + time caps                                    | `src/features/scripts/lib/scriptExecutor.ts`                                     |
| Redaction          | AI prompt + MCP/export redactors                                                       | `shared/protocol/ai/redaction.ts`, `electron/main/collection-export-redactor.ts` |
| Supply chain       | Developer-ID signing + notarisation; CI guard refuses unsigned mac release             | `electron-builder.json`, `.github/workflows/release.yml`                         |

The SSRF, sandbox, redaction, and worker-auth layers are documented in depth in
[`docs/security.md`](./security.md) and the website Security model page; the rest
of this document focuses on the secret-storage and supply-chain design, which is
where most of the subtlety lives.

## Secret storage & the OS keychain

### Two-tier key model

Restura never hands a user secret to electron-store directly. Instead:

1. A per-store **256-bit data key** (`crypto.randomBytes(32)`) encrypts the
   store contents.
2. That data key is **wrapped by the OS keychain** through Electron's
   `safeStorage` and persisted as a small blob in `userData`
   (`.encryption-key`, `.secret-handles-key`, `.vault-key`).

All of this lives in one place — `electron/main/encrypted-key.ts` — so the
policy ("prefer keychain, fall back loudly") is identical across every store. A
fix in one place lands everywhere.

There are three electron-store instances (credential store, the `SecretRef`
handle store, and the `pm.vault` store) kept separate so a user-chosen vault key
can't collide with an internally-generated handle UUID. They are intentionally
**not** merged.

### One keychain item, not three

A crucial implementation fact: on macOS, `safeStorage.encryptString` /
`decryptString` use a **single** OS keychain item per app (`restura Safe
Storage`) regardless of how many key files exist, and the derived key is
**cached in memory** after the first read per process. So all three stores cost
**one** keychain access per launch — not three. Designs that assume "N stores =
N prompts" are wrong, and the fix for repeated prompts is never "merge the
stores."

### `SecretRef` handle pattern (ADR 0007)

Secret-bearing auth fields store a handle — `{ kind: 'handle', id, label? }` —
in renderer state, never plaintext. The plaintext lives only in the main-process
handle store and is resolved (`unwrapSecretValueMain`) at the last possible
moment, just before wire-signing, then goes out of scope.

The single most important invariant: **`secret:resolve` is not exposed through
the preload bridge.** A test (`secret-handle-store.test.ts`) scans the source to
guarantee no `secret:resolve*` channel and no `resolveSecretHandle` reference
ever appears in the preload. Adding one would defeat the entire pattern.

### Key derivation: async, rotation-aware

Per Electron's [`safeStorage` guidance](https://www.electronjs.org/docs/latest/api/safe-storage),
the preferred path is the non-blocking async API. Restura derives keys via
`getOrCreateEncryptedKeyAsync()`:

- **`decryptStringAsync`** is non-blocking and handles temporary keychain
  unavailability gracefully (a momentarily-locked keychain no longer forces a
  degraded path).
- It returns **`shouldReEncrypt`**: when the OS rotates its storage key, the
  data key is transparently re-wrapped under the new key instead of drifting. A
  failed re-wrap is non-fatal — the decrypt already succeeded, so no data is
  lost.
- The keys are **pre-warmed once** at `app.whenReady()` (before the MCP-mode
  branch, so headless secret resolution works too). This makes the single
  keychain access happen at a predictable moment up front; the synchronous
  accessors thereafter just return the cached store and remain a self-init
  fallback for tests and any non-prewarmed path.

### Failure & recovery policy

| Condition                              | Behaviour                                                                                                | Rationale                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Keychain available, decrypt OK         | Use the key; re-wrap if `shouldReEncrypt`                                                                | Normal path                                                                                                                           |
| Keychain available, decrypt **throws** | Regenerate the data key (old records become undecryptable and are dropped), logged **loudly** as a reset | The master key was replaced/lost (item deleted, app re-signed) — self-heal keeps the app usable; the loud log makes the reset visible |
| Keychain **unavailable** (no keyring)  | Fall back to a `0o600` plaintext key file + persistent UI banner                                         | Mostly Linux without libsecret; documented degraded mode, never silent                                                                |

This is the honest trade-off: a genuinely lost master key self-heals (so the
"delete the keychain item and relaunch" recovery works), while the common
_transient_ unavailability is absorbed by the async path rather than destroying
recoverable data.

## macOS keychain prompts — by design vs. by misconfiguration

Users sometimes see macOS prompt repeatedly for keychain access. This is almost
never a store-count issue (see "One keychain item" above). It is a
**code-signing / keychain-ACL** symptom:

- A correctly **Developer-ID-signed + notarised** app installed to
  `/Applications` adds its designated requirement to the keychain item's ACL on
  first "Always Allow" and is **silent** thereafter.
- An **unsigned / ad-hoc** binary (e.g. a local `electron:dev` build) has no
  stable identity, so "Always Allow" can't persist → it re-prompts every launch.
- A **quarantined** app run from a DMG/Downloads is _translocated_ to a
  randomized read-only path each launch → ACL never matches → re-prompts.

On a developer machine the keychain item is often first created by a local dev
build, so the later notarised release sees an identity mismatch. Resolution:
grant "Always Allow" once to the signed app; if it persists, delete the stale
`restura Safe Storage` item and relaunch (this resets the encrypted-at-rest
stores).

## Supply-chain integrity (desktop)

The keychain ACL guarantee above is only as good as the signature. The build:

- Enables **hardened runtime** and **notarisation** (`electron-builder.json`),
  with minimal, justified entitlements (JIT, network-client, user-selected
  files — no app-sandbox, which would break a tool that makes arbitrary requests
  and reads user-selected certs/protos).
- Uses Electron **fuses** (`runAsNode:false`, cookie encryption,
  ASAR-integrity, `onlyLoadAppFromAsar`).
- Ships updates via signed GitHub releases with `allowDowngrade:false`.

Signing in CI is otherwise _silent-optional_ (absent secrets → unsigned), so a
guard in `.github/workflows/release.yml` **fails the macOS release** if
`CSC_LINK` / `APPLE_ID` are missing — an unsigned DMG can never be published
unnoticed (an unsigned release is the one scenario that gives end users
unfixable repeat-prompts).

## Platform asymmetry

|                            | Desktop                       | Web                                                                  |
| -------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| At-rest key                | OS keychain via `safeStorage` | In-memory / opt-in passphrase (PBKDF2) — no OS keychain in a browser |
| mTLS, custom CA, SOCKS/PAC | ✅                            | ❌ (no browser TCP)                                                  |
| SSRF guard                 | ✅ (+ DNS pinning)            | ✅ (Worker side)                                                     |

Capability parity is data-driven in `src/lib/shared/capabilities.ts` and gated
by `npm run capabilities:check`. The UI surfaces "Desktop only" badges rather
than failing silently.

## Reporting

Report security issues privately via
[GitHub security advisories](https://github.com/dipjyotimetia/restura/security/advisories/new).
See [`SECURITY.md`](../SECURITY.md).
