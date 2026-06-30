# PRD 05 — Response/Request Diffing + Desktop Traffic Capture

**Status:** Draft  
**Author:** Product  
**Date:** 2026-06-30  
**Targets:** Web (Cloudflare Pages + Worker), Self-host (Node/Docker), Desktop (Electron)

---

## 1. Summary

Extend Restura's existing comparison and capture infrastructure across two linked capabilities:

**Diffing** — Promote the current `EntryCompareDialog` (console-entry-vs-entry) into a first-class feature with semantic JSON diff, ignore-rule normalization, persistent baselines, and in-app diff assertions (a `ConsoleTest`-compatible step in the request Tests tab). Runs in the renderer on both web and desktop. CLI/CI baseline gating is Phase 2, pending baseline portability into exported collections.

**Traffic capture proxy** — Add a forward/intercept proxy in the Electron main process that intercepts traffic from any OS application or browser, not just traffic originating inside Restura. This is distinct from the existing `capture.desktopBridge`, which receives sessions POSTed by the Restura browser extension; the proxy can see non-browser apps (mobile simulators, CLIs, backend services). Reuses the established `shared/capture/` pipeline (schema, redaction, OpenCollection export). Desktop-only.

---

## 2. Problem & Evidence

### Diffing

API developers routinely compare two responses to spot regressions: "did the staging response change from yesterday?" "Is the v2 field shape the same as v1?" Today this is entirely DIY — developers use `jq`, `diff`, or paste bodies into external diff tools. No mainstream API client (Postman, Insomnia, Bruno, Hoppscotch) ships a first-class response-vs-baseline comparison with normalization for volatile fields (timestamps, nonces, request IDs). Restura's current `EntryCompareDialog` (`src/features/http/components/NetworkConsole/EntryCompareDialog.tsx`) compares two live `ConsoleEntry` objects using a line-level LCS (`src/lib/shared/line-diff.ts`), but has no ignore-rules, no JSON-semantic diff (key-reorder is a false diff), no baseline persistence, and no way to write this as a test assertion.

### Traffic capture

Capturing real traffic from other processes to build collections requires a separate tool in every current workflow: **mitmproxy** (CLI, no GUI collection builder), **Proxyman** (macOS-only, separate paid product), **Requestly** (~6.7k stars, mostly browser-scoped), or **Charles Proxy**. Hoppscotch required a standalone companion "Agent" binary specifically to escape browser sandbox limitations. Restura's Electron desktop app already has raw `net`/`tls` access (used in `safe-connect.ts`, `tcp-proxy-node.ts`), an established `shared/capture/` pipeline for sessions, and the `capture.desktopBridge` bridge — making a local interceptor proxy a logical extension at low marginal cost, rather than a separate product.

---

## 3. Goals / Non-Goals

### Goals — v1

**Diffing (both platforms)**

- Semantic JSON diff (key-order-independent, type-annotated) on response and request bodies.
- Configurable normalization: field-path ignore-rules to suppress volatile values (timestamps, trace IDs, nonces).
- Structured deltas: status code diff, latency delta (ms), size delta (bytes).
- Baseline persistence: save any `ConsoleEntry` or `HistoryItem` response as a named baseline; run a subsequent response against it.
- Diff-as-assertion: a dedicated test step in the collection request editor that runs the diff engine against a named baseline and emits a `ConsoleTest`-compatible result (pass/fail + diff output) visible in the in-app test results panel. CLI/CI gating of baselines requires baseline export (Phase 2 — baselines live in Dexie/renderer and are not yet readable by the standalone `@restura/cli` Node package).

**Traffic capture proxy (desktop-only)**

- HTTP/HTTPS forward proxy bound to `127.0.0.1:configurable-port`.
- TLS interception for a user-managed allowlist of target hostnames (decrypt only chosen hosts; all others CONNECT-tunnel opaque).
- Intercepted exchanges emit `CapturedExchange` objects through the existing `shared/capture/` pipeline → `sessionToOpenCollection` → collection import.
- Inline redaction via the existing `redactExchange` (`shared/capture/secret-extractor.ts`) before any exchange touches the renderer or persistence.
- Capability-gated UI that explicitly does not appear on web.

### Non-Goals — v1

- Full transparent/OS-level traffic capture (requires kernel extensions; ruled out).
- WebSocket frame capture via the proxy (CONNECT tunnel only; full WS decode is Phase 2).
- Diff of gRPC, GraphQL, or non-HTTP protocols in the first release (Phase 2).
- Semantic diff of non-JSON bodies (XML, protobuf) in the first release (plain line-diff fallback applies).
- The capture proxy becoming a general-purpose proxy tool with rewriting, throttling, or mock injection (that is `mock.localServer`).
- Multi-process or remote-agent capture; the proxy is localhost-only, configured manually on the device under test.

---

## 4. Target Users and Top Use Cases

| User                     | Context                      | Use case                                                                                                                   |
| ------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Backend API developer    | Daily request iteration      | Compare yesterday's staging response to today's; baseline-lock field shape                                                 |
| QA / automation engineer | In-app collection run        | Diff-as-assertion step flags when `/api/products` response schema diverges from saved baseline; CLI gate for CI is Phase 2 |
| Mobile developer         | App development on simulator | Point iOS Simulator HTTP proxy at Restura, capture and import requests as a collection                                     |
| Security researcher      | Third-party API analysis     | Capture a desktop CLI tool's HTTPS traffic without a separate proxy tool                                                   |
| API integrator           | Onboarding to a new API      | Capture real SDK traffic to auto-populate a collection with real headers, auth patterns, payloads                          |

---

## 5. User Stories

1. As a developer, I can right-click any console entry and click "Set as Baseline" so that future responses to the same endpoint can be compared against it.
2. As a developer, after sending a request I see a "Compare to Baseline" button if a baseline exists for that endpoint, so I can immediately diff without switching tools.
3. As a developer, I can configure ignore-rules (e.g. ignore `$.meta.requestId`, `$.data[*].updatedAt`) per endpoint so volatile fields do not produce false diffs.
4. As a QA engineer, I can add a `diff-baseline` assertion step in a collection request so that in-app collection runs flag a failure and output the diff when the response deviates from the saved baseline. (CLI/CI gating is Phase 2, once baselines are portable via collection export.)
5. As a developer, I can view a semantic JSON diff that shows changed, added, and removed keys regardless of field ordering in the JSON response.
6. As a desktop user, I can start a capture session in Restura that listens on `127.0.0.1:8888`, configure any app or simulator to use it as an HTTP proxy, and see intercepted requests appear live in a capture panel.
7. As a desktop user, I can choose which hostnames get TLS-decrypted in my capture session, keeping other traffic tunneled as opaque CONNECT.
8. As a desktop user, I can review all captured exchanges, apply redaction, and import a selection into a collection as a starting point.
9. As a desktop user, I can end a capture session and trust that no plaintext secrets have been written to disk — redaction runs before any data leaves the main process.

---

## 6. Functional Requirements

### 6.1 Diffing

#### 6.1.1 Diff sources

- **Console-entry vs console-entry** — existing `EntryCompareDialog` path; upgraded in place.
- **Console-entry vs baseline** — new path; baseline is looked up by a user-configured key (method + normalized URL).
- **History-item vs baseline** — `useHistoryStore` `HistoryItem` objects (which carry `Request` and `Response`) can be baseline-compared from the history sidebar.
- **Request vs request** — two request definitions (not responses); diff method, URL, headers, body. Useful for comparing collection items.

#### 6.1.2 Diff dimensions

- **Status code**: direct equality; flag if changed.
- **Latency delta**: numerical difference in milliseconds, with directional arrow (faster / slower).
- **Size delta**: bytes, with sign.
- **Response headers**: existing key-aligned diff with changed-row highlight, extended with add/remove indicators.
- **Request headers**: same.
- **Body — line diff (fallback)**: existing `diffLines` in `src/lib/shared/line-diff.ts` applies for non-JSON bodies (text, XML, binary previews). LCS threshold `MAX_DIFF_LINES=800` is preserved.
- **Body — semantic JSON diff (new)**: for JSON bodies, produce a key-path-level diff: value changed, key added, key removed, type changed. Ordering differences within objects are NOT flagged as changes (objects are key-sets, not arrays). Array element ordering IS flagged unless suppressed by an ignore rule.

#### 6.1.3 Normalization / ignore-rules

- Users configure a list of JSONPath expressions per baseline (e.g. `$.requestId`, `$.data[*].timestamp`, `$.meta.*`). Fields matching an expression are excluded from the semantic diff.
- A global ignore-list in settings applies across all baselines (e.g. `Date`, `X-Request-Id` header). **[assumption]** Global list is low-cardinality (fewer than 20 patterns typical).
- Normalized URL matching: before baseline lookup, strip common volatile query params (e.g. `_t=`, `nonce=`) — user-configurable list, default empty.

#### 6.1.4 Baselines

- A baseline is a named snapshot of: method, normalized URL, response status, response headers, response body, and the ignore-rules that should apply.
- Baselines are saved, named, updated, and deleted by the user. A single request can have multiple named baselines ("v1", "v2", "staging", "prod").
- Updating a baseline overwrites the prior snapshot; prior is not version-controlled in v1. **[assumption]** Version history of baselines is deferred.
- Baselines are persisted on both web and desktop (new Dexie table — see §10).

#### 6.1.5 Diff-as-assertion

- A diff assertion step in a collection request specifies: baseline name, fail-on: `any-difference | body-only | status-only`, and max acceptable latency delta.
- At run time the step fetches the named baseline from `useBaselineStore` (renderer-side Dexie), runs the diff engine, and emits a `ConsoleTest` (`name`, `passed`, `error?`) visible in the in-app test results panel.
- The diff output (path, before value, after value) is serialized to the `error` field as a compact JSON string when the assertion fails.
- **CLI/CI scope is Phase 2.** The `@restura/cli` is a standalone Node package with no renderer, no IndexedDB, and no access to `useBaselineStore`. To gate CI runs on baseline match, baselines must first be exported into the collection document (Phase 2 — requires both baseline export in `collection-export-redactor.ts` and CLI-side baseline loading). The `ConsoleTest` shape the step emits is already CLI-compatible; the missing piece is baseline portability, not the runner.

### 6.2 Traffic Capture Proxy

#### 6.2.1 Proxy architecture

- An HTTP forward proxy bound to `127.0.0.1` on a user-selected port (default 8888).
- HTTP requests: proxy straight through to upstream after SSRF validation; capture request + response as `CapturedExchange`.
- HTTPS requests: client sends `CONNECT host:443`, server responds `200 Connection established`.
  - If `host` is NOT on the user's TLS allowlist: tunnel opaque bytes, no decryption, capture metadata only (method=CONNECT, host, timing).
  - If `host` IS on the TLS allowlist: complete TLS interception — the proxy presents a per-host certificate signed by Restura's local CA; the upstream connection uses the standard TLS stack (via `tls.connect`). The full decrypted exchange is captured as a `CapturedExchange`.
- All upstream connections use `resolveSafeAddress` from `electron/main/security/safe-connect.ts` and the shared SSRF guard (`assertResolvedAddressAllowed` in `shared/protocol/url-validation.ts`). The proxy does not bypass the SSRF guard even for interception targets. **[RESOLVED — Option B]** The capture proxy has a **dedicated `allowLocalhost` toggle, separate from the global SSRF setting and defaulting to OFF**. Loopback/RFC-1918 capture works only when the user explicitly enables it for the capture session (e.g. capturing an iOS-simulator app talking to `localhost:8000`). This keeps the global Send defaults strict and makes the elevated-trust intent explicit per session. The flag is threaded into `resolveSafeAddress`/`validateURL` as `allowLocalhost` for proxy connections only.

#### 6.2.2 TLS interception trust model

- Restura generates a self-signed local CA at first capture-proxy start (stored in `app.getPath('userData')/capture-proxy-ca/`; private key never leaves that directory).
- The CA cert is exported as a `.crt` file the user installs in their OS trust store or browser. Installation is manual with guidance in the UI. Restura does NOT call any OS API to auto-install the certificate.
- On each intercepted host, Restura signs a leaf certificate on demand (RSA-2048 minimum, SAN matching the hostname). Certificates are cached in memory only — they are NOT persisted to disk.
- The CA can be revoked by the user (deletes the CA files; next proxy start generates a new CA). UI exposes a "Rotate CA" button.
- The local CA is distinct from the echo-local dev CA (generated by the `echo-local/` startup sequence for test infrastructure). The capture CA is per user data directory and is never committed to the repo.

#### 6.2.3 Capture session lifecycle

- The user starts a session; Restura starts the proxy server and emits the port. The capture panel shows intercepted exchanges in real time as they arrive (IPC push from main to renderer using an `eventChannel` channel, same pattern as SSE/WS streaming in `StreamRegistry`).
- The user stops the session; the proxy closes and no new exchanges are ingested.
- Exchanges accumulate in an in-memory session buffer (cap 5 000 exchanges, analogous to `useConsoleStore` `MAX_ENTRIES=100` but larger due to batch import use case). Once the cap is reached, oldest non-pinned exchanges are evicted.
- The user can select exchanges (multi-select), review their redacted form, and click "Import to Collection" to run `sessionToOpenCollection` and open the standard import dialog.
- Sessions are NOT auto-persisted between app restarts in v1. **[assumption]** Saved capture sessions (for later review) are Phase 2.

#### 6.2.4 Filtering

- The capture panel supports filter-by-host, filter-by-status, filter-by-MIME-type, and a URL search box — same filter controls as the NetworkConsole panel.
- Hosts on the TLS allowlist are editable mid-session; adding a host takes effect for new CONNECT tunnels only.

---

## 7. UX and Flows

### 7.1 Diff view

#### Entry points

- **Console Network tab → right-click entry → "Compare to..." → sub-menu**: "Compare with another entry" (existing, upgraded); "Compare with baseline" (new, if baseline exists for this endpoint); "Set as baseline" (new).
- **Response panel toolbar**: "Baseline" button with indicator (green checkmark = baseline exists + matches; amber = baseline exists but diverges; grey = no baseline).
- **History sidebar → right-click → "Set as baseline" / "Compare with baseline"**.
- **Collection request editor → Tests tab → "Add diff assertion"**.

#### Diff view layout (upgraded `EntryCompareDialog`)

```
+----------------------------------------------------------+
| Compare entries                                [X] close |
+----------------------------------------------------------+
| [Left: GET /api/users  200  12ms 841B  2026-06-30 09:14] |
| [Right: BASELINE "prod-v2"  200  --  847B  saved 06-29]  |
|                                                          |
| Status:  200  ←→  200   [MATCH]                         |
| Latency: 12ms ←→  --    [+12ms delta]                   |
| Size:    841B ←→  847B  [-6B delta]                      |
|                                                          |
| HEADERS (response)       [6 keys, 1 changed]             |
| +-----------------------+-----------------------------+  |
| | header name           | LEFT        | RIGHT        |  |
| +-----------------------+-----------------------------+  |
| | content-type          | app/json    | app/json     |  |
| | x-ratelimit-remaining | 42          | 38      [*]  |  |  ← changed row amber
| +-----------------------+-----------------------------+  |
|                                                          |
| BODY — semantic JSON diff              [ignore rules: 2] |
| (none when match; else key-path diff table):             |
| ~ $.data[0].updatedAt  "2026-06-29"  →  [ignored]       |
| + $.data[0].role       (absent)       →  "admin"   [ADD] |
| - $.meta.deprecation   "sunset: Q4"  →  (absent) [REMOVE]|
|                                                          |
| [Set as baseline]  [Update baseline]  [Add assertion]    |
+----------------------------------------------------------+
```

- Side-by-side header diff is preserved from the existing `EntryCompareDialog`.
- Semantic JSON diff replaces the raw body unified line-diff for JSON content types; line-diff is the fallback.
- "Ignore rules" button opens a small popover to add/edit JSONPath ignore-rules for the current baseline pair.

### 7.2 Capture session UI

#### Entry point

Settings → Capture (desktop-only section) → "Capture Proxy" card.  
Or: dedicated "Capture" tab in the left navigation sidebar (desktop-only, capability-gated via `isCapableHere('capture.proxy', isElectron())`).

#### Capture session wireframe

```
+----------------------------------------------------------+
| CAPTURE SESSION                            [Desktop only] |
+----------------------------------------------------------+
| Proxy:  127.0.0.1 : [8888 v]     [Start session]        |
| Status: ● Recording (143 exchanges)   [Stop]            |
|                                                          |
| TLS interception: [+ add host]                          |
| [api.example.com x]  [auth.example.com x]               |
| CA cert:  [Download CA cert]  [Rotate CA]               |
|                                                          |
| Filter: [search URL...] [host: all v] [status: all v]   |
+--+------+---+--------+--------+-----------+----------+---+
|  | Method | Status | Host         | Path       | Time |  |
+--+------+---+--------+--------+-----------+----------+---+
|☐ | GET    | 200    | api.example  | /users     | 34ms |  |
|☐ | POST   | 201    | api.example  | /users     | 89ms |  |
|☐ | CONNECT| --     | img.cdn      | (tunnel)   | --   |  |← opaque
|☐ | GET    | 401    | auth.example | /token     | 12ms |  |
+--+------+---+--------+--------+-----------+----------+---+
|  Select all  (4 selected)         [Import to collection] |
+----------------------------------------------------------+
| Click an exchange to see request + redacted response     |
+----------------------------------------------------------+
```

- Exchanges with decrypted content show full detail in a right-hand pane (same layout as the console NetworkTab entry detail, reusing existing `RequestEntryItem.tsx` and `EntryExpandDialog.tsx` where applicable).
- CONNECT-tunnel rows show `(tunnel / encrypted — not in allowlist)` in the path column and expose only host + timing.
- "Import to collection" opens the existing OpenCollection import dialog after running `sessionToOpenCollection` + `redactExchange` on the selected set.

---

## 8. Architecture and Implementation

### 8.1 Diff engine

**Location:** `src/lib/shared/diff-engine.ts` (renderer-side; runs client-only, no IPC needed).

The diff engine is a pure function over two JSON-parsed bodies (or plain text as a fallback):

```
diffResponses(left: DiffSide, right: DiffSide, rules?: IgnoreRules): DiffResult
```

where `DiffSide` carries `status`, `headers`, `body`, `latencyMs`, `sizeBytes`, and `DiffResult` carries `statusDelta`, `latencyDelta`, `sizeDelta`, `headerDiff: HeaderDiffRow[]`, `bodyDiff: BodyDiffEntry[]`.

`BodyDiffEntry` is a discriminated union:

- `{ op: 'equal' | 'changed' | 'added' | 'removed'; path: string; left?: JsonValue; right?: JsonValue }`

The semantic JSON walk is a recursive descent over two parsed objects. Key-ordering in objects is ignored (diff by key set). Arrays compare element-by-element by index. The existing `diffLines` in `src/lib/shared/line-diff.ts` remains unchanged as the non-JSON fallback path.

**Ignore-rule evaluation** runs at the `BodyDiffEntry` emission point: if the path matches any ignore-rule, the entry is tagged `ignored` rather than emitted as a change.

**Diff-as-assertion integration (in-app):** `src/features/scripts/lib/diffAssertion.ts` wraps `diffEngine.diffResponses`, fetches the named baseline from `useBaselineStore` (renderer-side Dexie), runs the diff, and returns a `ConsoleTest[]` array the existing in-app test harness emits. The CLI runner cannot reach `useBaselineStore`; CLI gating is Phase 2 (see §6.1.5).

**Upgraded `EntryCompareDialog`:** the existing `src/features/http/components/NetworkConsole/EntryCompareDialog.tsx` is extended to accept an optional `DiffResult` prop (pre-computed by the diff engine) and render the semantic diff alongside the existing header diff table. The component does not change its surface; the upgrade is internal.

### 8.2 Baseline store

**New Zustand store:** `src/store/useBaselineStore.ts` with `persist` middleware.

```
interface BaselineEntry {
  id: string;
  name: string;
  method: string;
  normalizedUrl: string;  // query-stripped per user config
  savedAt: number;
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    sizeBytes: number;
  };
  ignoreRules: string[];  // JSONPath expressions
}
```

Persisted to a new `baselines` table in `src/lib/shared/dexie-storage.ts` (add `'baselines'` to `StorageTableName` union, L57–81). Same encrypted Dexie adapter used by `history`, `console`, etc. The new table entry must also be added to `src/lib/shared/database.ts` in the Dexie schema version bump.

**Web + desktop parity:** both platforms use the same Dexie adapter from `src/lib/shared/dexie-storage.ts`. On desktop, the Dexie encryption key is sourced from `safeStorage` (OS keychain via the key provider in `electron/main/storage/collection-manager.ts`) rather than a browser-derived key, but the adapter interface and table schema are identical. No desktop-only persistence path is needed for baselines.

### 8.3 Capture proxy (desktop-only)

**Location:** `electron/main/handlers/capture-proxy-handler.ts` (new file, sibling to `capture-bridge-handler.ts`).

**Reused infrastructure:**

- `shared/capture/schema.ts` — `captureSessionSchema`, `CapturedExchange` types.
- `shared/capture/secret-extractor.ts` — `redactExchange` called on every intercepted exchange before IPC push.
- `shared/capture/to-opencollection.ts` — `sessionToOpenCollection` called at import time.
- `electron/main/security/safe-connect.ts` — `resolveSafeAddress` for the upstream TCP leg.
- `shared/protocol/url-validation.ts` — `assertResolvedAddressAllowed` SSRF guard.
- `electron/main/ipc/stream-registry.ts` — `StreamRegistry` for the per-session connection bookkeeping and renderer-destroyed cleanup.

**New per-proxy code (~350 lines estimated):**

1. `startCaptureProxy(options)` — creates an `http.createServer` that handles both plain HTTP and `CONNECT` tunneling. Bound to `127.0.0.1:port`.
2. `handleConnect(req, clientSocket, head, session)` — for each CONNECT: resolve target via `resolveSafeAddress`, check TLS allowlist, then either:
   - Not allowlisted: create a raw TCP pipe (`net.connect`) between client and upstream. Emit a minimal `CapturedExchange` with CONNECT metadata.
   - Allowlisted: negotiate a local TLS server socket (presenting the minted per-host cert), and a standard `tls.connect` to the upstream. Intercept bytes from both sides, decode HTTP/1.1 frames, emit full `CapturedExchange`.
3. `handleHttp(req, res, session)` — for plain HTTP: forward via `resolveSafeAddress` + `undici.fetch`, capture request + response, emit `CapturedExchange`.
4. `CaManager` — loads or generates the local CA. Key generation uses Node's `crypto.generateKeyPairSync` (RSA-2048); X.509 certificate construction and signing requires a library — recommended `@peculiar/x509` (pure TypeScript, no native deps, already used in the browser-extension capture path's downstream tooling) or `selfsigned` as a lighter alternative. Signs per-host leaf certs on demand (SAN, 1-year validity); caches signed `tls.SecureContext` objects in a `Map<string, tls.SecureContext>`. **New dependency: `@peculiar/x509` (or `selfsigned`) — evaluate supply-chain posture before selecting; see §15.**
5. `registerCaptureProxyIPC` — IPC surface following `createValidatedHandler` + `rateLimited` pattern from `capture-bridge-handler.ts`: `IPC.captureProxy.start`, `IPC.captureProxy.stop`, `IPC.captureProxy.status`, `IPC.captureProxy.setAllowlist`, `IPC.captureProxy.getCaCert`.

**IPC channel names** in `electron/shared/channels.ts`:

```
captureProxy: {
  start: 'captureProxy:start',
  stop: 'captureProxy:stop',
  status: 'captureProxy:status',
  setAllowlist: 'captureProxy:setAllowlist',
  getCaCert: 'captureProxy:getCaCert',
},
```

**Event push to renderer:** intercepted `CapturedExchange` objects are pushed via `webContents.send(EVENT.captureProxyExchange, redactedExchange)` where `EVENT.captureProxyExchange = 'captureProxy:exchange'`.

**Why web cannot do this:** browser-sandboxed JS has no access to `net`, `tls`, or any raw socket API. The Cloudflare Worker's `createTCPSocket` (via `nodejs_compat`) could in principle be wired as a forward proxy on the server side, but it would be a Worker-as-proxy-for-other-apps feature with no meaningful web deployment use case. The capture proxy is desktop-only.

**Parity story:** Web users retain the existing `capture.desktopBridge` browser-extension path. The new `capture.proxy` capability (desktop-only) is additive, not replacing.

---

## 9. Security Considerations

### 9.1 Diffing

- **No new attack surface**: the diff engine is a pure renderer-side function over already-received response bodies. It introduces no new IPC channels or outbound connections.
- **Baseline export redaction**: if baselines are exported (via collection export), `collection-export-redactor.ts` must treat the `baselines` store alongside existing stores. **[assumption]** Baseline export is out of scope v1; this is a gate for v2.
- **Stored baselines should not contain plaintext secrets**: the Dexie adapter encrypts at rest (same key as all other stores). This is sufficient if the baseline body was already received through the SSRF-guarded proxy (it was). Baselines sourced from the history store inherit that store's encryption context.

### 9.2 Capture proxy — critical surface

The capture proxy sees ALL traffic from apps configured to use it, including authorization headers, bearer tokens, session cookies, and response bodies. This is the highest-risk surface in this PRD.

**Opt-in and session scope**

- The proxy MUST NOT start on app launch. It is started explicitly by the user each session.
- The proxy is NOT persistent: it stops when the user clicks "Stop" or the app exits. `app.on('before-quit')` calls `stopCaptureProxy()`.
- A first-launch informational dialog (shown once) describes what the proxy captures and requires explicit confirmation.

**No persistence of plaintext secrets**

- `redactExchange` (`shared/capture/secret-extractor.ts`) runs on every `CapturedExchange` in the main process BEFORE the exchange is pushed to the renderer via IPC and BEFORE any exchange is written to memory beyond the in-process session buffer.
- The session buffer lives entirely in main-process heap; nothing is written to disk during a session (no Dexie writes, no electron-store writes, no JSONL log entries).
- At import time, the redacted `OpenCollectionDoc` from `sessionToOpenCollection` is imported through the standard collection import path; secrets discovered during redaction are surfaced as `SecretRef`-backed environment variables (following the existing `secret-extractor.ts` `RedactedSecret` → env-variable pattern).

**SSRF**

- Every upstream connection (HTTP plain + TLS upstream leg) goes through `resolveSafeAddress` and `assertResolvedAddressAllowed`.
- Cloud-metadata endpoints (`169.254.169.254`, `fd00:ec2::254`) are **always** blocked — no toggle reaches them. Private RFC-1918 / loopback targets are blocked **by default** and reachable only when the user turns on the dedicated capture-proxy `allowLocalhost` toggle for the session **[RESOLVED — Option B]**. This carve-out is narrower than AI Lab's (which keys off provider kind): it is an explicit, session-scoped, off-by-default user action, and it never relaxes the global Send guard or the metadata block.
- SSRF validation happens at the proxy's upstream-connect time, not at the client's CONNECT/GET send time. This closes the race-window gap.

**Local CA trust model**

- The CA private key never leaves `userData/capture-proxy-ca/` and is never sent over IPC.
- Leaf certificates are signed in the main process and passed to the in-memory TLS server context via `tls.createServer({ SNICallback })`. Leaf certs are never written to disk.
- **Installing the CA cert is a significant trust decision**: Restura must present clear, legible language in the CA download flow — not fine print. The UX copy must say: "Installing this certificate allows Restura to decrypt HTTPS traffic for the hosts you choose. Remove it from your trust store when you are done."
- `CaManager.rotateCa()` deletes the existing CA files and generates a new pair. Old leaf certs become invalid immediately (they chain to the deleted root).
- The CA cert's validity period is 1 year and the cert is marked `keyCertSign` + `cRLSign` only. It does NOT have `digitalSignature` so it cannot sign end-entity content directly.
- The echo-local dev CA (generated during `echo-local/` startup for test infrastructure) is a development artifact and is NOT the same CA instance. The production capture CA is generated per user data directory, not committed to the repo.

**DNS rebind and injection**

- The proxy binds `127.0.0.1` only, not `0.0.0.0`. Remote machines on the same LAN cannot reach it.
- The proxy rejects `Host` headers that don't match the resolved IP's hostname to prevent host-header injection attacks.
- Slow-loris guards are applied (same pattern as `capture-bridge-handler.ts` lines 113–114: `server.requestTimeout = 30_000`, `server.headersTimeout = 10_000`).

**Secret extraction coverage**
The existing `redactExchange` covers: Authorization header, API key headers, credential query params, Bearer/JWT token patterns in bodies, base64-encoded token payloads. Gaps that exist today also apply here (e.g. tokens embedded in JSON response fields by custom schema). Coverage is as-is from `shared/capture/secret-extractor.ts`; expanding coverage is a separate initiative.

---

## 10. Data Model / Persistence

### 10.1 Baselines (new, both platforms)

New Dexie table `baselines` — add `'baselines'` to `StorageTableName` union in `src/lib/shared/dexie-storage.ts` line 57 and add the table definition to `src/lib/shared/database.ts` in the next schema version bump.

```typescript
// Zustand store shape
interface BaselineEntry {
  id: string; // uuid
  name: string; // user-provided label
  method: string;
  normalizedUrl: string; // URL after volatile-param stripping
  savedAt: number;
  response: {
    status: number;
    headers: Record<string, string>;
    body: string; // encrypted at rest by Dexie adapter
    sizeBytes: number;
    latencyMs?: number; // populated when baseline is saved from a ConsoleEntry; absent when set from history or imported
  };
  ignoreRules: string[]; // JSONPath expressions
}
```

Encrypted at rest: the Dexie adapter's `encrypt: true` default applies. Body strings may be large; the existing `PERSIST_BODY_LIMIT` pattern in `useConsoleStore` (64 KB at persist boundary) should apply to baseline bodies as well — baselines larger than this are stored with a `truncated: true` flag and diff assertions on those baselines emit a warning.

### 10.2 Capture sessions (main-process only, no persistence in v1)

The in-memory session buffer is a plain `CapturedExchange[]` array in `capture-proxy-handler.ts`, capped at 5 000 entries. Nothing is written to Dexie or electron-store during a session. At import time the selected exchanges flow through `sessionToOpenCollection` and the resulting `OpenCollectionDoc` is handed to the renderer for the standard collection import flow (persisted via `useCollectionStore`).

Captured exchange redaction is performed in main-process memory. The `CapturedExchange` sent to the renderer via IPC is the output of `redactExchange`, never the raw object.

### 10.3 CA and leaf certificate storage

- CA private key + cert: `userData/capture-proxy-ca/ca.key` (PEM) and `ca.crt` (PEM). Both are written with mode `0o600`.
- Leaf certificates: memory only (`Map<string, tls.SecureContext>` in `CaManager`). Evicted when the proxy stops.
- No user data (history, collections, console entries) is stored in the CA directory.

---

## 11. Capability Matrix Impact

**New capability entries for `src/lib/shared/capabilities.ts`:**

```typescript
// Diff — available on both platforms
'diff.semantic': {
  label: 'Semantic JSON diff with normalization + baseline save',
  web: true,
  desktop: true,
  notes: 'Renderer-side diff engine; baselines persisted to Dexie on both platforms',
},
'diff.assertion': {
  label: 'Diff-as-assertion step (in-app; CLI gate is Phase 2)',
  web: true,
  desktop: true,
  notes: 'Emits ConsoleTest in the renderer test harness. CLI gate requires Phase 2 baseline export — baselines live in Dexie and are not readable by the standalone @restura/cli Node package.',
},

// Capture proxy — desktop only
'capture.proxy': {
  label: 'Desktop traffic capture proxy (HTTP/HTTPS interceptor)',
  web: false,
  desktop: true,
  notes: 'Forward proxy on 127.0.0.1; TLS interception for allowlisted hosts only. Distinct from capture.desktopBridge (browser extension receiver).',
},
```

After modifying `capabilities.ts`, run `npm run capabilities:matrix` to regenerate `docs/CAPABILITY_MATRIX.md`, and verify `npm run capabilities:check` passes before merging.

The existing `capture.desktopBridge` entry is unchanged.

---

## 12. Acceptance Criteria and Test Plan

### 12.1 Diff engine — Vitest unit tests

Location: `src/lib/shared/__tests__/diff-engine.test.ts`

- `diffResponses` returns `statusDelta: { changed: false }` when both sides are `200`.
- `diffResponses` returns `statusDelta: { changed: true, left: 200, right: 404 }` when statuses differ.
- Semantic JSON diff: `{ a: 1, b: 2 }` vs `{ b: 2, a: 1 }` → zero body diff entries (key-order insensitive).
- Semantic JSON diff: `{ a: 1 }` vs `{ a: 2 }` → one `changed` entry at path `$.a`.
- Semantic JSON diff: `{ a: 1 }` vs `{ a: 1, b: 2 }` → one `added` entry at path `$.b`.
- Semantic JSON diff: `{ a: 1, b: 2 }` vs `{ a: 1 }` → one `removed` entry at path `$.b`.
- Ignore rule `$.meta.requestId`: a diff on `{ data: 1, meta: { requestId: "abc" } }` vs `{ data: 1, meta: { requestId: "xyz" } }` → zero non-ignored body diff entries.
- Non-JSON body falls back to `diffLines` (verify output type is `LineDiffEntry[]`).
- Bodies above `MAX_DIFF_LINES=800` lines use the coarse fallback path (no LCS hang).
- Latency delta: `{ latencyMs: 100 }` vs `{ latencyMs: 150 }` → `latencyDelta: +50`.
- Size delta: `{ sizeBytes: 1024 }` vs `{ sizeBytes: 900 }` → `sizeDelta: -124`.

### 12.2 Diff-as-assertion — Vitest unit tests

Location: `src/features/scripts/lib/__tests__/diffAssertion.test.ts`

- Assertion passes when response matches baseline within configured tolerance.
- Assertion fails and `ConsoleTest.passed === false` when a key changes.
- Assertion `failOn: 'status-only'` passes even when body differs.
- Assertion `error` field is a valid JSON string containing at minimum `path` and `right` fields when failed.
- Ignored fields do not cause assertion failure.

### 12.3 Baseline store — Vitest unit tests

Location: `src/store/__tests__/useBaselineStore.test.ts`

- `saveBaseline` creates a new entry with the correct `normalizedUrl`.
- `updateBaseline` overwrites the body and `savedAt` of an existing entry.
- `deleteBaseline` removes the entry.
- `getBaselineByMethodUrl` returns the correct entry for a method + URL pair.
- Dexie persistence round-trip: save, reload store, entry is still present.

### 12.4 Capture proxy handler — Vitest tests

Location: `electron/main/__tests__/capture-proxy-handler.test.ts`

- `startCaptureProxy` binds to `127.0.0.1` only (assert `server.address().address === '127.0.0.1'`).
- A plain HTTP request through the proxy is captured as a `CapturedExchange` with `protocol: 'rest'`.
- A CONNECT request to a non-allowlisted host produces a `CapturedExchange` with tunnel metadata only (no `response.body`).
- `redactExchange` is called before IPC push (mock `redactExchange` and assert it was called).
- `resolveSafeAddress` is called for every upstream connection (mock it and assert).
- Exceeding the 5 000-exchange cap evicts the oldest entry.
- `stopCaptureProxy` closes the server and returns `{ running: false }`.

### 12.5 CA manager — Vitest tests

Location: `electron/main/__tests__/ca-manager.test.ts`

- First `getCa()` call creates key + cert files under a tmp `userData` path.
- Subsequent calls return cached object (no regeneration).
- `rotateCa()` deletes old files and generates new key + cert.
- Generated CA cert has `CA: true` basic constraint and `keyCertSign` usage.
- `mintLeafCert(hostname)` returns a cert with SAN matching the hostname.
- Leaf cert chains to the CA cert (verify with `crypto.createVerify`).

### 12.6 Capture proxy — Electron e2e tests

Location: `e2e-electron/capture-proxy.spec.ts`

- Start the capture proxy via IPC (`captureProxy:start`).
- Configure the echo-local HTTP server (`echo-local/ports.ts`) as the upstream.
- Send a plain HTTP request through the proxy using Node `http.request` pointing at `127.0.0.1:<proxyPort>`.
- Assert the renderer receives a `captureProxy:exchange` event with the correct method, URL, and status.
- Assert the `CapturedExchange` body does not contain any plaintext Authorization header value (redaction test).
- Stop the proxy; assert subsequent requests are refused.

---

## 13. Success Metrics

| Metric                         | Target                                                                                                  | Measurement                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Baseline diff adoption         | 20% of desktop active users have at least one saved baseline within 60 days of launch                   | Telemetry event `baseline_saved` (opt-in, same consent gate as existing `/api/telemetry/error`) |
| Diff assertion (in-app)        | 10% of active users run a diff-baseline assertion step within 90 days of launch (Phase 2 adds CLI gate) | Telemetry event `diff_assertion_ran` (opt-in)                                                   |
| Capture proxy sessions started | 15% of desktop active users start at least one capture session within 60 days                           | Telemetry event `capture_proxy_started`                                                         |
| Imported captures              | 30% of capture sessions result in a collection import                                                   | Telemetry event `capture_imported` / `capture_proxy_started` ratio                              |
| Proxy-related security reports | Zero                                                                                                    | GitHub Security Advisories, Sentry error rate on `captureProxy:*` IPC channels                  |

---

## 14. Rollout Phases

### Phase 1 — Diff (both platforms, ~2–3 weeks)

1. `shared/diff-engine.ts`: semantic JSON diff, normalization, status/latency/size deltas. Full Vitest coverage.
2. `src/store/useBaselineStore.ts` + new `baselines` Dexie table: save, update, delete, lookup. Vitest + Dexie round-trip.
3. Upgrade `EntryCompareDialog.tsx`: integrate diff engine output, render semantic body diff, expose "Set as baseline" / "Update baseline" / ignore-rules popover.
4. Capabilities: add `diff.semantic`, `diff.assertion` to `capabilities.ts`; regenerate matrix.
5. Diff-as-assertion step in collection request editor (Tests tab) — in-app result panel only. Vitest coverage. (CLI gating is not wired in Phase 1; see Phase 3.)

Phase 1 ships to web AND desktop — no platform gate needed.

### Phase 2 — Capture proxy (desktop-only, ~3–4 weeks)

1. `CaManager`: CA generation, leaf cert minting, rotation. Vitest.
2. `capture-proxy-handler.ts`: HTTP and CONNECT handling, StreamRegistry wiring, SSRF guard integration, redaction pipeline. Vitest.
3. IPC surface: `channels.ts` additions, `preload.ts` exposure, `electron-api.ts` types.
4. Renderer: Capture panel (new route or sidebar section), live exchange list, allowlist editor, CA download/rotate UI.
5. Capabilities: add `capture.proxy` to `capabilities.ts`; regenerate matrix.
6. e2e-electron spec against echo-local HTTP server.
7. Documentation: CA installation guide per OS (macOS Keychain, Windows Certificate Manager, Firefox/Chrome trust stores).

### Phase 3 — Deferred

- **Baseline export + CLI gate**: serialize baselines into the exported collection document; update `collection-export-redactor.ts` to include the `baselines` store; add CLI-side baseline loading to `@restura/cli` so `diff-baseline` assertion steps can gate CI runs. This unblocks the JUnit/GitHub Actions use case.
- Saved capture sessions (persist sessions to Dexie for later review).
- WS frame capture through the proxy (decode after CONNECT upgrade).
- Semantic diff for XML and protobuf bodies.
- Baseline version history.
- Broader diff entry points: gRPC, GraphQL response diff.

---

## 15. Risks and Open Questions

### Risks

| Risk                                                                             | Severity | Mitigation                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local CA becomes a supply-chain attack vector if the private key is stolen       | High     | Key stored at `0o600`, never leaves `userData`, never sent over IPC. Rotation is one-click. First-launch warning is explicit.                                                                                                                                                                 |
| "Scope creep" — capture proxy requests evolve into a full rewriting / mock proxy | Medium   | Hard v1 scope: capture only. Rewriting is `mock.localServer`; do not merge the two.                                                                                                                                                                                                           |
| Users install the CA and forget to revoke it                                     | Medium   | CA validity is 1 year (not 10 years). UI surfaces the expiry date prominently. Future: remind user on expiry.                                                                                                                                                                                 |
| TLS interception interacts poorly with certificate pinning (mobile apps)         | Low/Info | Certificate-pinned apps will refuse the leaf cert. This is expected behavior. Restura surfaces the TLS error in the exchange row; it is not a Restura bug.                                                                                                                                    |
| `redactExchange` coverage gaps: secrets in JSON fields by custom schema          | Medium   | Known gap; existing issue in `secret-extractor.ts`. A future "custom redaction patterns" setting can address it. Not a v1 blocker.                                                                                                                                                            |
| Diff assertion false positives on array ordering in real API responses           | Medium   | The ignore-rule system can suppress array-element ordering. The default is strict ordering. Consider a per-baseline "unordered arrays" option in v1.1.                                                                                                                                        |
| Large response bodies (>10 MB) in the diff engine blocking the renderer thread   | Low      | Semantic JSON diff runs on already-parsed JS objects; the parse is the expensive part and is already done. If profiling shows a bottleneck, move to a Web Worker. The `MAX_DIFF_LINES=800` line-diff fallback bounds the LCS path.                                                            |
| New npm dep for X.509 cert issuance (`@peculiar/x509` or `selfsigned`)           | Low      | Node `crypto` generates keys but not signed X.509 certificates with extensions (SAN, key-usage, CA flag) — a library is required. Evaluate supply-chain posture (maintenance, CVE history, license) before committing. Prefer the library already present elsewhere in the tree if one lands. |

### Open Questions

1. **Should diff-as-assertion be a dedicated test step type or a special `rs.diff()` API available inside test scripts?** The `rs.*` sandbox approach (via QuickJS in `scriptExecutor.ts`) would be more flexible but adds an API surface. A dedicated step type is simpler. Recommend the dedicated step type for v1 and evaluate `rs.diff()` for v2 based on demand.

2. **What is the UI surface for the capture proxy on the web target?** Recommendation: render a "Desktop only" capability badge (`<CapabilityBadge feature="capture.proxy">`) in the settings area and no other UI. Do not disable the settings nav item entirely — visibility aids discoverability.

3. **Should Restura generate a new CA per device or per app installation?** Recommendation: per `userData` directory (i.e. per Electron app instance). This means a developer running multiple Restura builds (prod and dev) gets separate CAs, which is correct — they should not share trust anchors.

4. **Should the capture proxy port be configurable per session or global-persistent?** Recommendation: global-persistent (saved in `useSettingsStore`) so the user does not have to reconfigure OS/simulator proxy settings after a restart. Port conflicts surface as a user-facing error with a "try another port" suggestion.

5. **Are there compliance scenarios where capturing any traffic (even redacted) is impermissible?** The capture proxy is always opt-in and session-scoped. No auto-capture. Organizations can disable it with a `RESTURA_DISABLE_CAPTURE_PROXY=true` env var (checked at startup) — this is an open question for the enterprise settings roadmap, not a v1 blocker.

---

## 16. Round-2 Review Addendum (verified findings)

Round-1 claims re-verified (diff symbols, capture-bridge, X.509-lib-required, Dexie v13). Deeper findings:

| #    | Tag         | Sev          | Finding                                                                                                                                                                                                                                          | Fix                                                                                                                                                                                                                                                                                     |
| ---- | ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | FEASIBILITY | **RESOLVED** | The PRD was self-contradictory on localhost (§9.2 blocked loopback; user stories require it).                                                                                                                                                    | **Decided: Option B** — a dedicated capture-proxy `allowLocalhost` toggle, default OFF, session-scoped, threaded into `resolveSafeAddress`/`validateURL` for proxy connections only. Global Send guard and the cloud-metadata block are never relaxed. Body updated in §6.2.1 and §9.2. |
| R2-2 | CONSISTENCY | High         | §8.1 frames the semantic JSON diff as an extension of `diffLines` (line-based LCS), but it's a **genuinely new ~150–200-line recursive-descent engine** (key-order-insensitive, array-aware, ignore-rule path matching) with its own test suite. | State it's a new module (`src/lib/shared/diff-engine.ts`); `diffLines` remains the non-JSON fallback. Don't undersell effort.                                                                                                                                                           |
| R2-3 | CONSISTENCY | High         | The `baselines` table (§10.1) needs the full Dexie migration, not "next version bump": declaration on `ResturaDB`, `version(14).stores`, `StorageTableName` union, `dexieStorageAdapters`, and `clearAllData`/`export`/`import`.                 | Add a Dexie integration checklist (model on `collectionRuns`).                                                                                                                                                                                                                          |
| R2-4 | SECURITY    | Med          | §9.2 says `redactExchange` runs before IPC push, but nothing in the architecture _enforces_ it — a future optimization could push raw exchanges and redact in the renderer (where plaintext is visible), defeating the design.                   | Introduce a sealed `RedactedExchange` brand type + a single `pushRedactedExchange()` chokepoint; add a test asserting raw exchanges can't be sent.                                                                                                                                      |
| R2-5 | CONSISTENCY | Med          | §12.4 tests CA generation but not the proxy's _use_ of it: per-host leaf-cert caching (`Map<host, SecureContext>`), SNI handshake success, and cert invalidation on `rotateCa()`.                                                                | Add tests for cert memoization, an e2e TLS handshake, and rotation-invalidation of active tunnels.                                                                                                                                                                                      |
