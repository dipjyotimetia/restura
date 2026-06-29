# Restura Browser Capture Extension — Design (Phase 1)

**Date:** 2026-06-28
**Status:** Approved design — ready for implementation plan
**Branch:** `worktree-browser-capture-extension`

## Goal

A Chrome (MV3) extension that captures live browser network traffic and turns it
into Restura collections — a more capable counterpart to Postman Interceptor.
Where Postman Interceptor does request capture + plaintext cookie sync + a proxy
bridge, Restura's extension adds **multi-protocol capture** (WebSocket / SSE /
GraphQL / gRPC-web), **secret-safe-by-construction redaction**, and a path into
Restura's downstream workbench (AI Lab, mock-gen, workflows).

### Phase 1 scope (this spec)

1. **CDP capture engine** — `chrome.debugger` (Network/WebSocket/EventSource domains).
2. **`shared/capture/` core** — backend-agnostic normalization, redaction, and
   export, imported by both the extension and Electron main (Approach C).
3. **Side-panel capture UI** — start/stop, live request list, protocol badges,
   filtering, selection.
4. **Two sinks:**
   - **Standalone export** — OpenCollection + HAR file, no Restura instance required.
   - **Desktop bridge** — token-paired localhost receiver in the Electron app that
     ingests a normalized capture session and builds a collection.
5. **Cookie / session sync** — export current cookies for a domain as redacted
   `SecretRef`-backed auth/environment material.

### Out of scope (future phases)

- **Phase 2:** OpenAPI 3.1 inference, smart endpoint sessionization/templating
  (`/users/:id`), per-route auth-scheme detection.
- **Phase 3:** AI-Lab eval-dataset generation from captured request/response pairs,
  mock-route generation, contract-drift diffing against a baseline collection.
- Web-app (`restura.dev`) live messaging integration and a CORS/localhost bridge
  for the web SPA. (Targets for v1 are **Desktop** + **Standalone** only.)

## Approach: shared-core extension (Approach C)

The codebase already lives by "one backend-agnostic core, thin per-target
adapters" (`shared/protocol/`). The extension follows the same pattern: capture
normalization, secret redaction, and collection/HAR building live **once** in
`shared/capture/`, and both the extension bundle and Electron main import them.

```
                     shared/capture/  (normalize · redact · export)
                                  │
              ┌───────────────────┴───────────────────┐
              ▼                                         ▼
   extension/ (service worker)                electron/main/handlers/
   CDP events → normalize → redact            capture-bridge-handler.ts
   → export file  OR  → POST to desktop       → build collection in Restura
```

Rejected alternatives:

- **Fat extension (A)** — reimplements OpenCollection/redaction inside the
  extension; drifts from Restura's audited logic.
- **Thin extension, desktop brains (B)** — tiny extension but standalone export
  breaks when desktop isn't running.

## Where the code lives

- **`extension/`** — new top-level subproject (own `package.json`, like `cli/` and
  `echo/`). MV3, built with **Vite + `@crxjs/vite-plugin`**, React + TypeScript +
  Tailwind v4 (reuses the existing toolchain). New `extension/tsconfig.json`
  extending `tsconfig.base.json`, wired into `npm run type-check:all` and the
  `npm run lint` globs.
- **`shared/capture/`** — new backend-agnostic module:
  - `types.ts` — `CapturedExchange`, `CaptureSession`, protocol discriminants.
  - `cdp-normalizer.ts` — CDP event sequence → `CapturedExchange[]`.
  - `protocol-classifier.ts` — REST·JSON / GraphQL / gRPC-web / WebSocket / SSE.
  - `secret-extractor.ts` — pull auth/cookies/tokens into `SecretRef` placeholders
    (reuses/extends `shared/protocol/ai/redaction.ts`).
  - `to-opencollection.ts` — `CaptureSession` → OpenCollection items.
  - `to-har.ts` — `CaptureSession` → HAR 1.2.

> **OpenCollection types dependency.** `to-opencollection.ts` needs the generated
> OpenCollection types currently under `src/lib/opencollection/spec-types.ts`. The
> plan must confirm those types are importable from `shared/` (move/re-export if
> the path boundary forbids `shared/ → src/`), and keep `spec-types.ts`
> generation (`verify:opencollection-types`) intact — never hand-edit it.

## Extension components

### Service worker (background)

- Owns `chrome.debugger` **attach/detach per user-selected tab**; enables CDP
  `Network` (+ WebSocket/EventSource events).
- Streams events → `cdp-normalizer` → `secret-extractor` → in-memory session.
- Fetches response bodies lazily via `Network.getResponseBody` on
  `Network.loadingFinished`.
- **MV3 ephemerality:** the service worker is killed when idle. The active
  `CaptureSession` persists to **IndexedDB** and re-hydrates on wake; the
  debugger attachment is re-established or the session is marked paused. This is
  the single biggest implementation gotcha — the plan must handle SW restart
  mid-capture explicitly.

### Side panel (`chrome.sidePanel`)

- Primary UI: start/stop capture for the active tab, live request list with
  protocol badges (REST/GraphQL/gRPC-web/WS/SSE), text + protocol + status
  filters, multi-select.
- Actions: **Export** (OpenCollection / HAR) and **Send to Desktop** (bridge).
- React app; reuses Restura UI primitives where practical (the extension bundle
  is separate, so a trimmed component set is acceptable).

### Popup

- Quick start/stop toggle for the active tab, capture status, button to open the
  side panel.

### Not in v1

- No content script and no DevTools panel — `chrome.debugger` supplies bodies
  directly, and the targets are desktop + standalone.

## Desktop bridge (Electron)

New `electron/main/handlers/capture-bridge-handler.ts`:

- A **127.0.0.1-only** receiver (minimal `http.Server` on a random port; or
  native-messaging as the alternative transport — see Open Questions).
- **Discovery:** the chosen port + a freshly generated per-session bearer token
  are written to a handshake file under Electron `userData`; the extension reads
  it (user pastes/loads the pairing token once, or the desktop app surfaces a
  pairing code).
- **Hardening:** loopback bind only; per-session bearer token required; `Origin`
  and `Host` header validation to defeat localhost CSRF / DNS-rebind from a
  malicious page; Zod payload validation (mirroring `ipc-validators` discipline);
  reject oversized payloads.
- On valid receipt: deserialize `CaptureSession` → `shared/capture/to-opencollection`
  → import as a collection / open prefilled tabs in Restura.
- Registered through the `IPC_MODULES` registry so teardown stays in sync
  (`register`/`dispose`), and the server is bound only while a capture import
  window is open (not always-on), to minimize the listening surface.

## Data flow

1. User clicks **Start capture** on a tab → SW attaches `chrome.debugger`, enables
   `Network`.
2. CDP events stream → normalized + **redacted as they arrive** (secrets never
   persisted raw) → appended to the session (persisted to IndexedDB).
3. Response bodies fetched lazily on `loadingFinished`.
4. User clicks **Stop** → reviews/filters the list in the side panel.
5. Either **Export** a file (OpenCollection / HAR) or **Send to Desktop**
   (POST to the bridge with the bearer token).
6. Desktop validates → builds a collection → user sees it in Restura.

## Security boundaries (audit surface)

This change touches Restura's security-critical surface → requires
`restura-security-auditor` review before merge.

- **Debugger scope** — attach only to explicitly user-selected tabs; detach on
  stop / tab close / SW teardown; show an unambiguous "capturing" state so the
  yellow CDP banner is never a surprise.
- **Redaction before persistence** — `secret-extractor` strips `Authorization`,
  `Cookie` / `Set-Cookie`, bearer / JWT tokens in bodies, and common token query
  params into `SecretRef` placeholders _before_ anything is written to IndexedDB,
  exported to a file, or sent over the bridge. Redaction completeness is covered
  by `tests/security/`.
- **Bridge auth** — loopback bind + per-session bearer token + `Origin`/`Host`
  validation + schema validation; reject on any mismatch. Covered by a security
  test (auth-rejection + malformed-payload rejection).
- **Cookie sync** — `httpOnly` / session cookies surface only as `SecretRef`
  handles, never plaintext, in exports.
- **Manifest least-privilege** — document each requested permission (`debugger`,
  `sidePanel`, `storage`, `cookies`, `tabs`, host permissions) and prefer
  per-tab opt-in where the API allows.

## Testing & gates

- **Unit (Vitest):** `shared/capture/` normalizer, classifier, secret-extractor,
  and exporters against **recorded CDP-event fixtures** (same fixture discipline
  as `shared/protocol/ai/providers/*`). Include WebSocket/SSE/GraphQL/gRPC-web
  fixtures.
- **Extension:** service-worker logic with mocked `chrome.*` APIs; side-panel
  components via React Testing Library.
- **e2e (Playwright):** `chromium.launchPersistentContext` loading the unpacked
  extension against the `echo` server → capture a request → assert the exported
  OpenCollection / HAR matches expectation.
- **Desktop bridge:** unit test token/Origin/Host + payload validation; one
  wiring test through the handler.
- **Security tests** (`tests/security/`): redaction completeness; bridge
  auth-rejection.
- **Gates:** `extension/tsconfig.json` wired into `type-check:all`; lint globs
  updated; new **ADR `docs/adr/0024-browser-capture-extension.md`**; capability
  matrix entry for the desktop-bridge feature (`capabilities.ts` →
  `capabilities:check`); `verify:opencollection-types` stays green.

## Open questions for the implementation plan

1. **Bridge transport:** loopback `http.Server` + handshake file (pragmatic) vs.
   a Chrome **native-messaging** host (no open port, but requires an installed
   native manifest). Default to loopback HTTP for v1; revisit if pairing UX is
   poor.
2. **OpenCollection type sharing:** confirm whether `shared/ → src/lib/opencollection`
   import is allowed or the generated types must be relocated/re-exported.
3. **Pairing UX:** how the user transfers the bridge token from desktop to the
   extension (paste a code vs. desktop writes a file the extension can read — the
   latter needs a known path the extension can access, which it cannot read
   directly, so a paste/code flow is likely required).

## Success criteria (Phase 1)

- Capture a multi-protocol session (an XHR/fetch JSON call **and** a WebSocket or
  SSE stream) on a real page and see it live in the side panel.
- Export an OpenCollection that re-imports cleanly into Restura with **no
  plaintext secrets** present.
- Send the same session to the running desktop app over the token-paired bridge
  and see the collection appear in Restura.
- All gates green: `type-check:all`, `lint`, `format:check`, security suite,
  `capabilities:check`, `verify:opencollection-types`, unit + e2e capture tests.
