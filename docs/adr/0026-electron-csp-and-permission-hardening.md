# ADR 0026: Electron CSP Tightening and Default-Deny Web Permissions

**Status:** Accepted, 2026-07-02

## Context

Two renderer-facing hardening gaps survived the earlier security passes (ADR-0004, ADR-0006):

1. **Web permissions.** Electron grants many web-platform permission requests by default (notifications, media, fullscreen, clipboard, …). Restura's renderer needs almost none of them — every privileged operation (native notifications, filesystem, network) already goes through the validated IPC surface — but nothing asserted that, so a compromised renderer could still exercise Electron's default-grant behavior.
2. **CSP directives.** The production CSP (header policy in `electron/main/main.ts`, mirrored as a `<meta>` fallback in `vite.config.mts` for the `file://` load path) had no `object-src` or `worker-src` directive, and nothing checked that the two hand-maintained copies stayed identical.

## Decision

- **Default-deny permission handlers** on `session.defaultSession`: both `setPermissionRequestHandler` and `setPermissionCheckHandler` reject every permission except `clipboard-sanitized-write` (needed by the renderer's copy buttons via `navigator.clipboard.writeText`). The allowlist is a single `ALLOWED_WEB_PERMISSIONS` set in `electron/main/main.ts`; applied in dev and prod alike (unlike the CSP, there is no HMR reason to relax it). Native notifications are unaffected — they go through the main-process `Notification` API over IPC, not the web permission model.
- **CSP additions**: `object-src 'none'` and `worker-src 'self' file:` in both copies. Monaco's editor workers are Vite `?worker` chunks loaded same-origin, so no `blob:` source is needed. `connect-src 'self' https: wss:` stays deliberately broad — the renderer talks directly to https origins on the web transport path and for Sentry.
- **Parity is enforced, not assumed**: `electron/main/__tests__/security-hardening.test.ts` parses both policies out of the sources and fails if they diverge (modulo the header-only `frame-ancestors`), if `script-src` ever grows `'unsafe-eval'`, or if the permission allowlist grows without the test being updated deliberately.
- **Inline theme script allowed by hash (amended 2026-11).** `index.html` runs one tiny inline script before React mounts to apply the persisted theme; under `script-src 'self'` it was silently blocked on web and desktop, so the theme flashed on every load. Every renderer CSP (`public/_headers`, `main.ts`, `vite.config.mts`) now allows exactly that script by `'sha256-…'` — never `'unsafe-inline'`. The same test fails, printing the new hash, if the script changes or any copy lacks it. The self-hosted Node server sends no CSP and is unaffected.

## Consequences

**Positive**

- The renderer's web-permission surface is now closed by default; Electron's default-grant behavior can't silently re-appear.
- CSP drift between `main.ts` and `vite.config.mts` is caught by a unit test instead of relying on code review.

**Negative / process**

- Any future feature that needs a web permission (e.g. camera/microphone, web notifications) must add it to `ALLOWED_WEB_PERMISSIONS` **and** update the structural test — an explicit, reviewable security decision.
- The CSP is still maintained in two places (a runtime header and a build-time meta tag); the test reduces but does not remove that duplication.

## Amendment (2026-11-07): no Ajv in renderer-reachable code

The no-`unsafe-eval` script policy also blocks Ajv, which compiles validators with `new Function`. AI Lab scorers, agent-suite graders (`shared/agent-lab`) and contract checks (`src/features/contracts/lib/validator.ts`) were silently broken on the packaged desktop app. They now use the eval-free, interpreter-style checker in `shared/protocol/json-schema-check.ts` (a keyword subset, listed in its header; unsupported keywords are annotations). Contract checks first normalise OpenAPI 3.0 `nullable` and boolean `exclusiveMinimum` / `exclusiveMaximum`. Ajv stays in Node-only code (Electron main, CLI, Worker), e.g. the Kafka JSON Schema codec. An architecture ratchet (ADR 0028) keeps Ajv imports out of `src/` and `shared/`.

## References

- Code: `electron/main/main.ts` (`setupPermissionHandlers`, `setupContentSecurityPolicy`), `vite.config.mts` (`ELECTRON_RENDERER_CSP`), `electron/main/__tests__/security-hardening.test.ts`
- Related: [ADR 0004 (security hardening)](./0004-security-hardening.md), [ADR 0006 (connection + DNS hardening)](./0006-electron-connection-and-dns-hardening.md)
