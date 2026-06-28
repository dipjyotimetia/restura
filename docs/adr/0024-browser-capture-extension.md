# ADR 0024: Browser Capture Extension

**Status:** Accepted (Phase 1 implemented), 2026-06-28

## Context

Restura's web build cannot capture arbitrary browser traffic or reach localhost
(browser sandbox + CORS), the same limitation Postman Interceptor fills for
Postman. We want a capture extension that beats Interceptor on Restura's home
turf: multi-protocol capture (WebSocket / SSE / GraphQL / gRPC-web), secrets that
never leak, and a clean path into Restura's collection/AI workbench.

Two forces shape the design. First, the capture pipeline — normalize, classify,
redact, export — is identical whether the consumer is the extension's own export
button or the desktop app; duplicating it would drift from Restura's audited
redaction (ADR 0007) and OpenCollection logic. Second, MV3's `chrome.webRequest`
cannot see response bodies, so rich capture needs `chrome.debugger` (CDP).

## Decision

**Approach C — one backend-agnostic core, thin adapters**, mirroring
`shared/protocol/`.

- **`shared/capture/`** holds the entire pipeline as pure, Zod-typed modules:
  `cdp-normalizer` (CDP Network/WebSocket/EventSource events → `CapturedExchange`),
  `protocol-classifier`, `secret-extractor` (redacts into `{{name}}` placeholders +
  reports secrets), `to-har`, `to-opencollection`. `schema.ts` is the source of
  truth — types are `z.infer`'d from it, and the same `captureSessionSchema`
  validates untrusted bridge payloads. The module **never imports from `src/`**;
  it emits the OpenCollection document shape directly (schema-conformance is
  verified by a renderer-side test, not a shared→src import).

- **`extension/`** is a new MV3 subproject (Vite multi-entry — `@crxjs/vite-plugin`
  predates Vite 8 — React + Zod). A service worker owns a **single, per-tab
  `chrome.debugger` attachment**, streams events through the shared normalizer,
  redacts as exchanges complete, and persists the session to
  `chrome.storage.session` so an MV3 worker restart mid-capture loses nothing.
  Side panel + popup + options pages drive it. Two sinks: **standalone**
  OpenCollection/HAR file export (no Restura required) and **Send to Desktop**.

- **`electron/main/handlers/capture-bridge-handler.ts`** is a 127.0.0.1-only HTTP
  receiver. Pure auth/origin logic lives in `capture-bridge-protocol.ts`
  (separately unit-tested, electron-free). It converts received sessions via the
  shared core and pushes an OpenCollection doc to the renderer
  (`EVENT.captureReceived`). Gated by capability `capture.desktopBridge`.

Targets for Phase 1 are **Desktop + Standalone** only; web-app messaging and a
CORS bridge for the web SPA are deferred.

## Security

- `chrome.debugger` attaches only to the user-selected tab and detaches on stop /
  tab close / worker teardown.
- **Redaction precedes every persistence/export/transmit.** `secret-extractor`
  strips the `CREDENTIAL_HEADER_NAMES` denylist + `x-*-(token|key|secret)` +
  JWT/Bearer/`key=val`/prefixed-provider-token body patterns. Completeness is a
  security regression test (`tests/security/capture-redaction.test.ts`).
- Bridge hardening: loopback bind, per-pairing bearer token, `Origin`/`Host`
  loopback validation (DNS-rebind / CSRF defence — a malicious page can POST to
  127.0.0.1 but carries a remote `Origin`), Zod payload validation, body-size cap.
  Token is shown to the trusted renderer only, never over the HTTP surface.
- Pairing is user-initiated: desktop surfaces a `<port>:<token>` code the user
  pastes into the extension options page. The extension cannot read the desktop
  handshake file directly.

## Consequences

- The capture logic is testable without a browser (unit tests over recorded
  CDP-event fixtures), and the extension/desktop share exactly one redaction path.
- Live `chrome.debugger` capture is **not** end-to-end tested: Playwright is a CDP
  client and a second debugger attach on the same target conflicts. The e2e
  (`e2e/extension-capture.spec.ts`) loads the real bundle in new-headless Chromium
  and exercises the UI → storage → shared-export path; the CDP path is covered by
  normalizer fixtures.
- `@crxjs/vite-plugin` is avoided until it supports Vite 8; the plain multi-entry
  build is the tradeoff (no extension HMR, but version-proof).

## Future (Phases 2–3)

OpenAPI 3.1 inference and smart endpoint sessionization; AI-Lab eval-dataset
generation, mock-route generation, and contract-drift diffing from captured
traffic.
