# ADR 0008: safeStorage Key Lifecycle and Renderer Hardening

**Status:** Accepted, 2026-05-31

**Related:** [ADR 0004 — security hardening](./0004-security-hardening.md), [ADR 0007 — SecretRef pattern](./0007-secret-ref-pattern.md).

## Context

An investigation into **repeated macOS keychain permission prompts** during install
concluded the prompts were a code-signing / keychain-ACL symptom — a `restura Safe
Storage` keychain item first created by a local unsigned `electron:dev` build, whose
ACL doesn't match the notarised release's Developer-ID identity — **not** a code bug.
(A correctly signed, notarised, non-translocated app prompts once and then stays
silent. `safeStorage` uses a single keychain item per app and caches the key in
memory per process, so "N stores = N prompts" is a myth.)

The investigation nonetheless surfaced four hardening gaps worth closing together:

1. **Blocking, rotation-unaware key derivation.** `getOrCreateEncryptedKey` used the
   synchronous `safeStorage.encryptString` / `decryptString`. Electron recommends the
   async API because it is non-blocking, absorbs _transient_ keychain unavailability,
   and surfaces `shouldReEncrypt` for OS key rotation. The sync path treated a
   transient decrypt failure the same as a lost key — by regenerating, which silently
   resets the encrypted-at-rest stores.
2. **No session permission policy** (Electron security checklist #5). Permission
   decisions fell to Chromium defaults instead of an app-controlled deny-by-default.
3. **Non-uniform IPC sender validation** (checklist #17). Most handlers validate the
   sender frame via `assertTrustedSender` (inside `createValidatedHandler` /
   `createValidatedListener`), but a few raw handlers bypassed it: `store:set`,
   `store:clear` (credential-store mutations), `window:new`, the window min/max/close
   listeners, and `notification:isSupported`.
4. **Silent-optional macOS signing.** CI shipped an unsigned DMG when the Apple
   secrets were absent — and an unsigned release is the _one_ scenario that gives end
   users unfixable repeat keychain prompts.

## Decision

1. **Async, rotation-aware key lifecycle.** Add `getOrCreateEncryptedKeyAsync`
   (`electron/main/encrypted-key.ts`) using `decryptStringAsync` /
   `encryptStringAsync`; honour `shouldReEncrypt` to transparently re-wrap the data
   key after an OS keychain-key rotation. **Pre-warm** all three electron-store keys
   once at `app.whenReady()` (before the MCP-mode branch, so headless secret
   resolution works too); the synchronous accessors return the cached store and remain
   a self-init fallback for tests and any non-prewarmed path. The loud-warning
   self-heal on a genuinely lost/replaced key is retained (it keeps the "delete the
   keychain item and relaunch" recovery working), and the `0o600` plaintext fallback
   for a missing OS keyring (mainly Linux without libsecret) is unchanged.
2. **Deny-by-default permission policy** (`electron/main/permission-policy.ts`):
   `setPermissionRequestHandler` + `setPermissionCheckHandler` grant only
   `clipboard-sanitized-write` (the copy buttons — the renderer's sole permission
   need); camera, microphone, geolocation, MIDI, notifications, etc. are denied.
3. **Uniform IPC sender validation.** Every handler now asserts the sender frame —
   `store:set` / `store:clear` call `assertTrustedSender` explicitly; `window:new`,
   the window controls, and `notification:isSupported` route through the validated
   wrappers.
4. **Fail-closed CI signing.** A guard in `.github/workflows/release.yml` fails the
   macOS release leg when `CSC_LINK` / `APPLE_ID` are absent.

## Consequences

**Positive**

- A _transient_ keychain unavailability no longer resets the encrypted stores; OS
  key rotation is handled transparently rather than as a (silent) reset.
- A rendered-response XSS or malicious collection can't silently obtain a device
  permission.
- IPC sender validation is consistent across the whole surface — no raw exceptions.
- An unsigned macOS DMG can no longer be published unnoticed.

**Negative**

- Prewarm opens all three stores at startup (one keychain touch, up front) even when
  the user never touches secrets that session.
- Deny-by-default means a future renderer feature needing a new permission must be
  added to the allow-list explicitly, or it silently fails.
- The sync key path is retained as a fallback, so two derivation paths coexist; in
  production the async prewarm always runs first, so the sync path only fires in
  tests / edge cases.

## Explicitly NOT changed (with rationale)

- **CSP `connect-src 'self' https: wss:`** kept — load-bearing: the Electron renderer
  opens `new WebSocket(url)` directly for header-less connections, so it can't be
  tightened without breaking functionality.
- **DNS-rebind residual** for gRPC-reflection / Kafka / Socket.IO / MCP — pre-flight
  only by necessity (those client libraries lack a `lookup` hook); tracked in
  [ADR 0006](./0006-electron-connection-and-dns-hardening.md).
- **macOS app-sandbox** not enabled — impractical for a developer tool that makes
  arbitrary outbound requests and reads user-selected certs/protos. Hardened runtime
  - notarisation is the correct bar for this app class.

## Alternatives considered

- **Consolidate the three key files into one master key to reduce prompts.** Rejected
  — `safeStorage` caches the key per process, so three key files already cost one
  keychain touch; consolidating reduces prompts by zero.
- **Fail hard (never regenerate) on a decrypt failure.** Rejected — it would strand
  the legitimate lost-key recovery path; the loud-warning self-heal is the chosen
  middle ground (the async API protects the transient case).
- **Remove the `resetAdHocDarwinSignature` fuse.** Rejected — it's required: fuse
  flipping invalidates the signature, this re-applies ad-hoc so the arm64 binary runs,
  and electron-builder signs the real Developer ID over it.

## References

- `electron/main/encrypted-key.ts`, `permission-policy.ts`
- `electron/main/store-handler.ts`, `secret-handle-store.ts`, `vault-handler.ts`, `main.ts`
- `.github/workflows/release.yml`
- `docs/SECURITY_DESIGN.md` — the consolidated security design this ADR feeds into
