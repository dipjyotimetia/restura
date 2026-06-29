# Browser Capture Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome MV3 extension that captures live multi-protocol browser traffic via `chrome.debugger` and turns it into Restura collections (standalone OpenCollection/HAR export + a token-paired desktop bridge), with all capture/normalize/redact/export logic in a backend-agnostic `shared/capture/` core reused by both the extension and Electron.

**Architecture:** Approach C — one shared core, thin adapters. `shared/capture/` holds pure functions (normalize CDP events → `CapturedExchange`, classify protocol, redact secrets, export OpenCollection/HAR). The `extension/` subproject (Vite + `@crxjs/vite-plugin`, MV3) owns CDP attachment and UI. `electron/main/handlers/capture-bridge-handler.ts` is a 127.0.0.1 receiver modeled on `mock-server-handler.ts`.

**Tech Stack:** TypeScript, React 19, Vite 8, `@crxjs/vite-plugin`, Tailwind v4, Zod, Vitest, Playwright, Electron `http.Server`, Chrome MV3 (`debugger`, `sidePanel`, `storage`, `cookies`, `tabs`).

## Global Constraints

- Node.js 24+. Strict TS (`tsconfig.base.json`: `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noImplicitReturns`). `exactOptionalPropertyTypes` is OFF.
- **`shared/` MUST NOT import from `src/`.** Mirror needed types locally (precedent: `shared/protocol/types.ts`). So `to-opencollection.ts` emits the OpenCollection document shape directly; it does not import `src/lib/opencollection`.
- Secrets: redact `Authorization`, `Cookie`/`Set-Cookie`, JWT/Bearer/`key=val` tokens, prefix tokens (`sk-`, `AKIA`, `ghp_`, `xox*`, `AIza`) BEFORE any persistence/export/transmit. Reuse the denylist logic style of `shared/protocol/ai/redaction.ts` + `shared/protocol/credential-header-names.ts`.
- Electron IPC/inbound: 127.0.0.1 bind only; Zod-validate every payload; `assertTrustedSender` on IPC; per-session bearer token + `Origin`/`Host` checks on the bridge.
- Gates that must stay green: `type-check:all`, `lint` (globs must include `extension`), `format:check`, `tests/security/*`, `capabilities:check`, `verify:opencollection-types`.
- New ADR: `docs/adr/0024-browser-capture-extension.md`.

---

### Task 1: `shared/capture/types.ts` — capture data model

**Files:**

- Create: `shared/capture/types.ts`
- Test: (none — types only; exercised by Task 2+)

**Interfaces — Produces:**

- `type CapturedProtocol = 'rest' | 'graphql' | 'grpc-web' | 'websocket' | 'sse'`
- `interface CapturedHeader { name: string; value: string }`
- `interface CapturedBody { text?: string; base64?: string; mimeType?: string; truncated?: boolean }`
- `interface CapturedExchange { id: string; protocol: CapturedProtocol; method: string; url: string; startedAt: number; request: { headers: CapturedHeader[]; body?: CapturedBody }; response?: { status: number; statusText?: string; headers: CapturedHeader[]; body?: CapturedBody }; frames?: CapturedFrame[]; graphql?: { operationName?: string; operationType?: 'query'|'mutation'|'subscription' } }`
- `interface CapturedFrame { direction: 'sent' | 'received'; opcode?: number; payload: CapturedBody; at: number }`
- `interface CaptureSession { id: string; createdAt: number; origin?: string; exchanges: CapturedExchange[] }`

- [ ] Write the file with the interfaces above. No logic.
- [ ] `tsc --noEmit` against the extension tsconfig (Task 9) — defer check to Task 2.
- [ ] Commit: `feat(capture): capture data model types`

---

### Task 2: `shared/capture/protocol-classifier.ts` — classify an exchange

**Files:**

- Create: `shared/capture/protocol-classifier.ts`
- Test: `shared/capture/__tests__/protocol-classifier.test.ts`

**Interfaces:**

- Consumes: `CapturedProtocol` (Task 1)
- Produces: `classifyProtocol(input: { url: string; requestHeaders: CapturedHeader[]; requestBodyText?: string; isWebSocket?: boolean; isEventStream?: boolean }): { protocol: CapturedProtocol; graphql?: {...} }`

Rules: `isWebSocket` → `websocket`; `isEventStream` or response `content-type: text/event-stream` → `sse`; request `content-type` starts `application/grpc-web` → `grpc-web`; body parses as JSON with a `query` string (and optional `operationName`/`variables`) OR url ends `/graphql` → `graphql` (extract `operationName` + first keyword `query|mutation|subscription`); else `rest`.

- [ ] Write failing tests: one per protocol (rest JSON, graphql by body, graphql by url, grpc-web by content-type, websocket flag, sse by content-type). Assert `protocol` and (for graphql) `operationName`/`operationType`.
- [ ] Run: `npx vitest run shared/capture/__tests__/protocol-classifier.test.ts` → FAIL (module missing).
- [ ] Implement `classifyProtocol` with the rules above.
- [ ] Run tests → PASS.
- [ ] Commit: `feat(capture): protocol classifier`

---

### Task 3: `shared/capture/secret-extractor.ts` — redact secrets

**Files:**

- Create: `shared/capture/secret-extractor.ts`
- Test: `shared/capture/__tests__/secret-extractor.test.ts`

**Interfaces:**

- Consumes: `CapturedExchange`, `CapturedHeader` (Task 1); import `CREDENTIAL_HEADER_NAMES` from `../protocol/credential-header-names`.
- Produces: `redactExchange(ex: CapturedExchange): { exchange: CapturedExchange; secrets: { name: string; placeholder: string }[] }` — returns a deep-cloned exchange with denied header values replaced by `{{secretName}}` placeholders and body token patterns masked; `secrets[]` lists the variable names a consumer should create as `SecretRef`.

Header denylist: exact set from `CREDENTIAL_HEADER_NAMES` + regex `^x-.*-(token|key|secret)$`, `^api[-_]?key$`. Body masking: reuse the JWT/Bearer/`key=val`/prefix-token regexes (copy from `redaction.ts`; this is allowed — `shared/`→`shared/` import of the header-name constant, regexes duplicated since `redaction.ts` does not export them).

- [ ] Write failing tests: (a) `Authorization: Bearer x` → header value becomes a placeholder + secret recorded; (b) `Cookie` redacted; (c) JWT in response body masked; (d) a non-secret header (`Accept`) untouched; (e) original object not mutated.
- [ ] Run vitest → FAIL.
- [ ] Implement `redactExchange` (deep clone via `structuredClone`, header pass, body pass on `request.body.text`/`response.body.text`/frame payloads).
- [ ] Run tests → PASS.
- [ ] Commit: `feat(capture): secret-safe redaction`

---

### Task 4: `shared/capture/cdp-normalizer.ts` — CDP events → exchanges

**Files:**

- Create: `shared/capture/cdp-normalizer.ts`
- Test: `shared/capture/__tests__/cdp-normalizer.test.ts`
- Fixtures: `shared/capture/__tests__/fixtures/*.json` (recorded CDP event arrays: one REST request, one WebSocket, one SSE)

**Interfaces:**

- Consumes: Task 1 types, `classifyProtocol` (Task 2)
- Produces: `class CdpNormalizer { ingest(method: string, params: unknown): void; getExchanges(): CapturedExchange[] }` keyed by CDP `requestId`. Handles `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`, `Network.webSocketCreated`, `Network.webSocketFrameSent`, `Network.webSocketFrameReceived`, `Network.eventSourceMessageReceived`. Response bodies are injected separately via `attachResponseBody(requestId, body: CapturedBody)` (the SW fetches them lazily through `Network.getResponseBody`).

- [ ] Write failing tests driving the normalizer with each fixture array; assert exchange count, method/url, protocol classification, and (for WS) frame count.
- [ ] Run vitest → FAIL.
- [ ] Implement the event-driven assembler.
- [ ] Run tests → PASS.
- [ ] Commit: `feat(capture): CDP event normalizer`

---

### Task 5: `shared/capture/to-har.ts` — HAR 1.2 export

**Files:**

- Create: `shared/capture/to-har.ts`
- Test: `shared/capture/__tests__/to-har.test.ts`

**Interfaces:**

- Produces: `sessionToHar(session: CaptureSession): HarLog` (HAR 1.2 `{ log: { version, creator, entries[] } }`). WS/SSE frames go into entries' `_webSocketMessages`/comments (HAR has no native frame slot).

- [ ] Failing test: a one-REST-exchange session → assert `log.entries[0].request.url/method` and `response.status`.
- [ ] vitest → FAIL → implement → PASS.
- [ ] Commit: `feat(capture): HAR export`

---

### Task 6: `shared/capture/to-opencollection.ts` — OpenCollection export

**Files:**

- Create: `shared/capture/to-opencollection.ts`
- Test: `shared/capture/__tests__/to-opencollection.test.ts`

**Interfaces:**

- Produces: `sessionToOpenCollection(session: CaptureSession, opts?: { name?: string }): OpenCollectionDoc` where `OpenCollectionDoc` is a locally-declared minimal shape matching the published schema: `{ openCollection: '1.0.0'; info: { name }; items: HttpItem[]; environments?: [{ name; variables: ({secret:true;name}|{name;value})[] }] }`. REST/GraphQL → http items (`{ type:'http', name, request:{ method, url, headers:[{name,value}], body? } }`). Redacted secrets become `{{name}}` references + a `Captured` environment listing `{ secret:true, name }`.

- [ ] Failing test: redacted session → assert `openCollection==='1.0.0'`, one item with method/url, and that `Authorization` header value is a `{{...}}` reference (no plaintext); assert the doc passes `openCollectionSchema.safeParse` (import the schema in the TEST only, from `src/lib/opencollection`, since tests run under the renderer config).
- [ ] vitest → FAIL → implement → PASS.
- [ ] Commit: `feat(capture): OpenCollection export`

---

### Task 7: `shared/capture/index.ts` barrel + security test

**Files:**

- Create: `shared/capture/index.ts` (re-export public API)
- Test: `tests/security/capture-redaction.test.ts`

- [ ] Barrel exports: types, `classifyProtocol`, `redactExchange`, `CdpNormalizer`, `sessionToHar`, `sessionToOpenCollection`.
- [ ] Failing security test: build a session containing every secret class (auth header, cookie, JWT body, `sk-` token), export to both HAR and OpenCollection, assert NONE of the raw secret strings appear in the serialized JSON.
- [ ] vitest → FAIL → make pass (fix any leak) → PASS.
- [ ] Commit: `test(security): capture redaction completeness`

---

### Task 8: Electron desktop bridge handler

**Files:**

- Create: `electron/main/handlers/capture-bridge-handler.ts` (model on `mock-server-handler.ts`)
- Modify: `electron/main/main.ts` (register in `IPC_MODULES`), `electron/shared/channels.ts` (add channels), `src/lib/shared/capabilities.ts` (+ `capture.desktopBridge` desktop-only entry)
- Test: `electron/main/handlers/__tests__/capture-bridge-handler.test.ts`

**Interfaces:**

- Produces: `registerCaptureBridge()` / `disposeCaptureBridge()`. Starts `http.Server` on `127.0.0.1:0`; writes `{ port, token }` to a handshake file in `app.getPath('userData')/capture-bridge.json`; accepts `POST /ingest` with `Authorization: Bearer <token>`, validates `Origin`/`Host` are absent or loopback, Zod-validates a `CaptureSession`, runs `sessionToOpenCollection`, emits an IPC event to the renderer to import it.
- Consumes: `sessionToOpenCollection`, `CaptureSession` (Task 6/1).

- [ ] Failing tests (pure helpers, exported): `isAuthorized(headers, token)` rejects missing/wrong token; `isLoopbackOrigin(headers)` rejects `http://evil.com`; payload Zod schema rejects oversized/malformed.
- [ ] vitest → FAIL → implement handler + helpers → PASS.
- [ ] Wire `IPC_MODULES`, channels, capabilities. Run `npm run capabilities:matrix` to regenerate the doc.
- [ ] Commit: `feat(capture): electron desktop bridge receiver`

---

### Task 9: Extension subproject scaffold

**Files:**

- Create: `extension/package.json`, `extension/tsconfig.json` (extends `../tsconfig.base.json`, `types: ['chrome']`, path to `../shared`), `extension/vite.config.ts` (`@crxjs/vite-plugin`), `extension/manifest.config.ts`, `extension/src/manifest.ts`, `extension/index.html` (side panel), `extension/popup.html`
- Modify: root `package.json` (add `extension` workspace + `type-check:all` line `tsc --noEmit -p extension/tsconfig.json`), `lint` glob (+`extension`), `.gitignore` (`extension/dist`)

**Interfaces — Produces:** an installable MV3 manifest with permissions `["debugger","sidePanel","storage","cookies","tabs"]`, `host_permissions: ["<all_urls>"]`, `side_panel.default_path`, `action.default_popup`, `background.service_worker`.

- [ ] Scaffold files (manifest, configs). Install dev deps: `@crxjs/vite-plugin`, `@types/chrome`.
- [ ] Run `npm run --workspace extension build` → succeeds, emits `extension/dist` with `manifest.json`.
- [ ] Run `tsc --noEmit -p extension/tsconfig.json` → clean.
- [ ] Commit: `feat(extension): MV3 subproject scaffold`

---

### Task 10: Extension service worker — CDP capture

**Files:**

- Create: `extension/src/background/index.ts`, `extension/src/background/session-store.ts` (IndexedDB persistence)
- Test: `extension/src/background/__tests__/session-store.test.ts` (mock IndexedDB), `__tests__/background.test.ts` (mock `chrome.debugger`)

**Interfaces:**

- Consumes: `CdpNormalizer`, `redactExchange`, `CaptureSession`.
- Produces: message API `{ type:'capture:start', tabId }`, `{ type:'capture:stop' }`, `{ type:'capture:get' }`; uses `chrome.debugger.attach({tabId},'1.3')`, `Network.enable`, listens `chrome.debugger.onEvent` → `normalizer.ingest`, fetches bodies via `Network.getResponseBody`, redacts, persists session to IndexedDB (survives SW restart), detaches on stop.

- [ ] Failing tests: session-store round-trips a session through IndexedDB; background `capture:start` calls `chrome.debugger.attach` and `Network.enable`; `capture:stop` calls `detach`.
- [ ] vitest → FAIL → implement → PASS.
- [ ] Commit: `feat(extension): CDP capture service worker`

---

### Task 11: Extension side panel + popup UI

**Files:**

- Create: `extension/src/sidepanel/{main.tsx,App.tsx,RequestList.tsx,ExportBar.tsx}`, `extension/src/popup/{main.tsx,App.tsx}`, `extension/src/lib/bridge-client.ts`
- Test: `extension/src/sidepanel/__tests__/RequestList.test.tsx` (RTL)

**Interfaces:**

- `bridge-client.ts`: `sendToDesktop(session: CaptureSession): Promise<void>` — reads paired `{port,token}` from `chrome.storage`, POSTs to `http://127.0.0.1:<port>/ingest`.
- UI: start/stop, live list (protocol badge, method, url, status), protocol+text filter, Export (downloads HAR/OpenCollection via `sessionToHar`/`sessionToOpenCollection` + `Blob`), Send to Desktop.

- [ ] Failing RTL test: `RequestList` renders exchanges with protocol badges + status; filter input narrows the list.
- [ ] vitest → FAIL → implement components + popup → PASS.
- [ ] Commit: `feat(extension): side panel + popup UI`

---

### Task 12: Pairing flow + e2e + docs

**Files:**

- Create: `extension/src/options/` (paste pairing token → `chrome.storage`), `e2e/extension-capture.spec.ts`, `docs/adr/0024-browser-capture-extension.md`
- Modify: `docs/CAPABILITY_MATRIX.md` (regenerated), `playwright.config.ts` if a separate project is needed

**Interfaces:** options page writes `{ port, token }` to `chrome.storage.local`; e2e loads unpacked `extension/dist` via `chromium.launchPersistentContext({ args:['--load-extension=...','--disable-extensions-except=...'] })`, navigates to the echo server, captures, asserts an exported OpenCollection contains the request and no plaintext secrets.

- [ ] Write the e2e spec (capture → export → assert).
- [ ] Run `npx playwright test e2e/extension-capture.spec.ts` → PASS (build extension first).
- [ ] Write ADR 0024 (decision: Approach C, CDP engine, loopback bridge, redaction boundary).
- [ ] Commit: `feat(capture): pairing flow, e2e, ADR-0024`

---

### Task 13: Full gate sweep

- [ ] `npm run type-check:all` → clean (includes the new extension tsconfig line).
- [ ] `npm run lint` → clean (extension in globs).
- [ ] `npm run format:check` (or `npm run format`).
- [ ] `npx vitest run shared/capture tests/security/capture-redaction.test.ts electron/main/handlers/__tests__/capture-bridge-handler.test.ts` → all pass.
- [ ] `npm run capabilities:check` → clean. `npm run verify:opencollection-types` → clean.
- [ ] Final commit if any fixups: `chore(capture): pass full gate sweep`.

## Self-Review notes

- Spec coverage: capture engine (T4,T10), shared core (T1–T7), side-panel UI (T11), standalone export (T5,T6,T11), desktop bridge (T8), cookie/session sync → covered by redaction + OpenCollection environment emission (T3,T6); a dedicated cookie-export action can fold into T11's ExportBar.
- `shared/`→`src/` boundary honored: OC doc shape is local (T6); only the _test_ imports the renderer schema for validation.
- Security: redaction precedes persistence (T3 used inside T10 before IndexedDB write) and export (T6); bridge auth/origin/schema (T8); completeness security test (T7).
