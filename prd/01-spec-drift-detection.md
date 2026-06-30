# PRD: Live Response-vs-Spec Drift Detection

**Status:** Draft — v1 scope  
**Author:** PM Agent  
**Date:** 2026-06-30  
**Target:** Restura v1 release

---

## 1. Summary

Restura's contracts feature has a fully implemented validation library (`src/features/contracts/lib/`) that can validate any HTTP response against an OpenAPI 3.x spec — but that library is never called during normal request execution. This feature wires that library into the live request/response cycle so every response is passively and silently checked against its spec, surfacing drift inline in the response panel as a badge with a drillable error list.

**Value proposition:** The only API client that shows you, in real time, when your API's live response has drifted from its contract — without leaving the tool you already use to test APIs.

---

## 2. Problem and Evidence

### The market gap

Optic — the leading open-source API diff and drift detection tool — was archived on 2026-01-12 (https://github.com/opticdev/optic) after acquisition by Atlassian. No open-source successor has emerged. SmartBear has repositioned its Swagger tooling explicitly around the API drift problem that AI coding assistants have created (https://thenewstack.io/smartbear-swagger-ai-api-management). Research consistently shows approximately 70% of API production failures stem from contract drift despite green CI pipelines.

### The structural gap in current tooling

Every existing drift-detection approach is out-of-band: a CI linter runs against a spec file, a proxy records traffic and diffs it, or a test suite explicitly asserts on response shape. None of these solutions observe the live response at the moment the developer sends a request in their client and sees the response. The developer's client is the only place that sees both the spec (attached to the collection) and the real response simultaneously.

### Restura's unique position

Restura already holds both inputs:

- The spec is attached at collection or folder scope (`Collection.contractSpec`, `CollectionItem.contractSpec` in `src/types/collection.ts:50-75`) and optionally pinned per-request via `HttpRequest.contractRef` (`src/types/http.ts:65-67`).
- The response is available in the renderer immediately after execution, before it reaches the history store or the UI.

The `validateResponse` and `matchOperation` functions in `src/features/contracts/lib/validator.ts` and `src/features/contracts/lib/operationMatcher.ts` are already tested and correct — they simply are not called anywhere in the request execution path. This is a wiring gap, not a capability gap.

---

## 3. Goals and Non-Goals

### Goals (v1)

- Passively validate every HTTP/GraphQL response against the nearest attached OpenAPI 3.0 or 3.1 spec, without the user having to click "Validate."
- Surface a compact drift badge inline in the `ResponseViewer` response header bar (same row as status code, size, time).
- Provide a drillable "Contract" panel tab in the response panel showing per-field errors with JSON Pointer paths.
- Auto-match by URL + method (via `matchOperation`) when no explicit `contractRef` is set.
- Respect explicit operation pins (`contractRef.operationId`) when set.
- Support all three spec sources already in the type system: `inline`, `url`, `file` (desktop only).
- Work identically across web, self-host, and desktop (platform-neutral, renderer-only).
- Allow opt-out at collection or request level (a toggle in `CollectionSettingsDialog` and per-request `RequestSettingsEditor`).

### Non-Goals (v1)

- AsyncAPI support: the `ContractSpecSource.kind` field already reserves `'asyncapi'`, but AsyncAPI covers event-driven protocols (Kafka, MQTT, WebSocket). Deferred to v2.
- GraphQL schema-level type checking (introspection schema versus query shape). GraphQL requests ARE HTTP, so the HTTP response envelope (status, content-type, JSON body structure as declared in any linked OpenAPI spec) is validated, but introspection-schema-driven field-level checking is out of scope.
- Swagger 2.0 support. OpenAPI 3.0 and 3.1 only (the existing validator already gates on this: `specLoader.ts:83`).
- Historical drift trending or export of drift results.
- gRPC, WebSocket, SSE, Kafka, MQTT, MCP protocol validation. The feature is HTTP/GraphQL only in v1.
- CI integration or CLI (`@restura/cli`) drift reporting (v2).
- Automatic spec inference from response samples (the `codegen.ts` module already generates types from samples — that is a distinct feature).
- External `$ref` resolution in specs (already blocked in `specLoader.ts:77` with `resolve: { external: false }`).
- Streaming response validation (SSE/NDJSON streams; each event would need per-frame schema).

---

## 4. Target Users and Top Use Cases

**Primary user:** A backend developer or API consumer using Restura as their daily API client. They have an OpenAPI spec for the service they are calling — either their own (for regression testing) or a third party's (for integration work).

**Top use cases:**

1. A developer makes a change to a Go/Python/TypeScript handler and runs a Restura request to smoke-test it. They see a drift badge immediately because they forgot to add a required field to the response.
2. A frontend developer consuming a third-party API notices a drift badge on a field whose type changed from `string` to `integer` — something the vendor changelog did not mention.
3. A QA engineer running a collection against a staging environment wants passive coverage on every request: any response that deviates from the contract is flagged without writing a single test script.
4. An AI-assisted development workflow: the AI coding tool regenerates a handler; the developer sends a request and the drift badge confirms or rejects the regenerated code's contract fidelity before pushing.

---

## 5. User Stories

- **US-01:** As a developer, I want a drift indicator to appear automatically on every response when my collection has a spec attached, so I do not have to remember to run a separate validation step.
- **US-02:** As a developer, I want to click the drift badge and see exactly which field failed, its JSON Pointer path, the expected type or constraint, and the value that was received, so I can diagnose the drift in under 10 seconds.
- **US-03:** As a collection owner, I want to attach a spec to my collection once and have it automatically cover every request in that collection, so I do not need to configure validation per-request.
- **US-04:** As an advanced user, I want to pin a specific `operationId` to a request so the correct operation is used even when URL matching is ambiguous.
- **US-05:** As a developer, I want to opt out of passive drift detection for a specific request (e.g. a request that intentionally triggers an undeclared error path), so I am not spammed with known irrelevant drift.
- **US-06:** As a collection owner, I want to disable passive drift detection for an entire collection without removing the attached spec (e.g. I want the spec for codegen but not for passive validation), so I have granular control.
- **US-07:** As a developer, I want the drift check to be near-instant (< 50 ms) for any spec I've already loaded, so it does not slow down my development flow.

---

## 6. Functional Requirements

### FR-01: Passive invocation

Drift validation runs automatically after every successful HTTP or GraphQL request execution, whenever a spec is resolvable. It does NOT block execution or add latency to the request itself — it runs concurrently in the renderer after the response arrives.

**What "spec is resolvable" means:**

1. The active request belongs to a collection (via `collectionId` on the active tab in `useRequestStore`). **[assumption: tab state carries `collectionId`]**
2. That collection or any ancestor folder has a `contractSpec` set.
3. The spec can be found in the in-memory cache (or loaded on demand).

If no spec is resolvable (e.g. the request is a standalone tab not in a collection), no badge or tab is shown.

### FR-02: Operation matching

Two paths for finding the right OpenAPI operation:

**Explicit pin (higher precedence):** `HttpRequest.contractRef.operationId` set. The validator calls `findOperationById(spec, operationId)` from `src/features/contracts/lib/operationMatcher.ts:82`.

**Automatic URL matching (fallback):** `matchOperation(spec, request.method, request.url)` from `src/features/contracts/lib/operationMatcher.ts:44`. Uses the templated path matching already implemented (`{id}` placeholders, server base-path stripping, query-string removal).

If neither path finds a match, the badge reads "No operation match" — distinct from "Drift detected" — and no error list is shown (it is not a drift error, it is a coverage gap).

### FR-03: What constitutes drift

The feature declares drift using the same rules as `validateResponse` in `src/features/contracts/lib/validator.ts:126`:

| Check                                        | Severity | Notes                                                       |
| -------------------------------------------- | -------- | ----------------------------------------------------------- |
| Status code not declared in spec             | Error    | Via `pickResponseKey` — exact, NXX class, then `default`    |
| Content-Type not declared for matched status | Error    | Via `pickMediaType` — exact, wildcard-subtype, `*/*`        |
| Body fails JSON Schema                       | Error    | Full Ajv validation with `allErrors: true`; per-field paths |
| Required response header missing             | Warning  | Only headers declared `required: true` in spec              |

**Severity levels:**

- **Error:** The response is structurally invalid against the spec. Developer action expected.
- **Warning:** The response is usable but deviates from a declared requirement. Advisory.
- **Info:** (v2) Advisory notes such as `deprecated: true` on the matched operation.

### FR-04: OpenAPI 3.0 vs 3.1 dialect selection

Derived from the loaded spec's `openapi` field by `loadContractSpec` in `src/features/contracts/lib/specLoader.ts:83`. OpenAPI 3.0.x → Ajv Draft-07; OpenAPI 3.1.x → Ajv Draft 2020-12. No user configuration required.

### FR-05: GraphQL handling

A GraphQL request in Restura is an HTTP POST with body type `'graphql'` (`src/types/http.ts:14`). If the collection has an OpenAPI spec and the request has a `contractRef`, the HTTP response envelope (status, content-type, JSON body) is validated as an ordinary HTTP response. The query-level shape (whether `data.user.name` exists) is NOT validated in v1 — that requires a GraphQL schema, not an OpenAPI spec.

If no explicit `contractRef` is set, `matchOperation` attempts URL + method matching against the OpenAPI spec. For most GraphQL deployments, a single `POST /graphql` operation will be declared; auto-match will find it.

### FR-06: AsyncAPI (placeholder)

`ContractSpecSource.kind === 'asyncapi'` is already in the type system (`src/types/collection.ts:52`). When this kind is detected in v1, the feature silently skips validation and renders no badge. This preserves the field for v2 without breaking the data model.

### FR-07: Always-on vs opt-out

Passive validation is **on by default** when a spec is attached to the collection or folder. Two opt-out mechanisms:

- **Collection/folder level:** A new boolean field `driftDetection.enabled` on `Collection` and `CollectionItem`. Set via a toggle in `CollectionSettingsDialog`. Default: `true` when a `contractSpec` is present.
- **Request level:** A new boolean field `driftDetection.skip` on `HttpRequest`. Set via `RequestSettingsEditor`. Default: `false`.

The per-request skip takes precedence over the collection toggle. This allows "disable collection-wide, enable per-request" and "enable collection-wide, disable per-request" patterns.

### FR-08: Performance budget

- Spec parse and `$ref` dereference (`loadContractSpec`) runs once and is cached in-memory in `useContractStore`. Subsequent requests against the same spec skip the parse step.
- Ajv schema compilation is already cached in `validator.ts:107-120` (the `compileCache` Map keyed on `dialect + stringified schema`).
- A response validation call for a typical JSON response (< 10 KB, < 20 Ajv errors) should complete in under 20 ms on modern hardware. **[assumption: based on Ajv's documented sub-millisecond validation for pre-compiled schemas]**
- Large response bodies (> 1 MB) should validate the first 1 MB only and surface a note indicating truncation. This prevents Ajv from OOM-ing on intentionally large test payloads.

---

## 7. UX and Flows

### 7.1 Attaching a spec (existing flow, no change)

The `CollectionSettingsDialog` (`src/features/collections/components/CollectionSettingsDialog.tsx:52`) already has the contract spec attachment UI (URL, inline, file). No changes to this flow.

### 7.2 Drift badge in the response header

The `ResponseViewer` component at `src/components/shared/ResponseViewer.tsx:159` renders a Floater with a header bar containing status, size, time stats. A compact drift badge is added to this bar, to the right of the existing stats:

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ 200 OK   ·  1.23 KB  ·  142 ms  ·  HTTP/2  │ DRIFT  2 errors   [▼] [Contract]│
└────────────────────────────────────────────────────────────────────────────────┘
```

Badge states:

- **Hidden:** No spec attached to the collection.
- **Loading spinner:** Spec is being loaded (first hit, not yet cached).
- **No match (gray):** Spec loaded but no operation matched the request URL/method. Tooltip: "No operation match in spec — check contractRef or URL pattern."
- **Pass (green checkmark):** Spec matched and response is fully valid.
- **Warning (amber shield + count):** Validation found only warnings (e.g. missing non-required declared headers).
- **Error (red alert + count):** One or more errors. Count shows total error count.

### 7.3 Contract tab in the response panel

The existing `ResponseTab` type in `src/components/shared/ResponseViewer.tsx:112` is:

```
'body' | 'headers' | 'cookies' | 'timeline' | 'tests' | 'preview' | 'visualize'
```

A new `'contract'` tab is added. It is only rendered when a spec is attached to the collection (the tab appears/disappears based on spec presence, not drift presence — the tab slot is stable once a spec is attached). The tab label carries the badge count when errors exist: "Contract (2)".

**Contract tab layout:**

```
  Contract (2 errors)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ Spec: my-api.yaml  ·  Matched: GET /users/{id}  ·  Status: 200 ✓       │
  ├──────────────────────────────────────────────────────────────────────────┤
  │ Body                                                                     │
  │  ✗  /email     type — expected string, got integer                      │
  │  ✗  /roles     required field missing from response                     │
  │                                                                          │
  │ Status                                                                   │
  │  ✓  200 matched response key "200"                                      │
  │                                                                          │
  │ Headers                                                                  │
  │  ⚠  X-Trace-Id   required header missing                               │
  └──────────────────────────────────────────────────────────────────────────┘
  [ Open spec ]   [ Pin operation ID ]
```

Each error row shows: field path (JSON Pointer rendered as human-readable breadcrumb), Ajv keyword, human message. Clicking the path on a body error highlights that path in the Monaco body editor (integration with `responseEditorRef` already available in `ResponseViewer.tsx:178`).

### 7.4 Per-request operation pin flow

From the request builder, an `operationId` selector appears in `RequestSettingsEditor` when the collection has a spec. The user picks an operation from a searchable dropdown populated from the cached spec. This writes to `HttpRequest.contractRef.operationId`.

### 7.5 "No spec attached" prompt

When a user runs a request from a collection that has no spec, a subtle non-intrusive prompt appears below the status bar: "Attach an OpenAPI spec to this collection to enable drift detection." Links to `CollectionSettingsDialog` with the Contract tab pre-focused.

---

## 8. Architecture and Implementation

### 8.1 Validation stays in the renderer

**All drift validation logic (parse, dereference, Ajv compile, match, compare) runs in the renderer process** — no changes to `shared/protocol/` or the Electron main process for the validation itself, and no IPC overhead. **One exception (see §8.6):** fetching a spec from a remote URL on **web** must route through the existing Worker `/api/proxy` (the browser is CORS/network-bound and the SSRF guard must run server-side), so the feature is not _purely_ renderer-only on web. Desktop fetches the spec URL directly through the Electron fetcher. The validation engine itself is platform-neutral; only the spec-fetch transport differs by platform — exactly like every other protocol in Restura.

The reason validation belongs in the renderer (not `shared/protocol/`): the spec is renderer state (attached to a collection in `useCollectionStore`); Ajv is a renderer-side dependency (lazy-loaded, already in use in `validator.ts:81`); the response is immediately available to the renderer. The proxy/worker layer has no access to the collection spec.

### 8.2 New module: `useContractStore`

`specLoader.ts:17` explicitly documents: "Caching is the responsibility of `useContractStore` — this module is stateless." This store needs to be created.

**File:** `src/features/contracts/store/useContractStore.ts`

```typescript
// Key data:
interface ContractState {
  // In-memory cache: spec source key → loaded spec
  specs: Map<string, SpecLoadResult>;
  // Loading/error state per spec key
  specStatus: Map<string, 'loading' | 'error'>;
  specErrors: Map<string, string>;
  // Action: load or return cached
  getOrLoadSpec: (source: ContractSpecSource) => Promise<SpecLoadResult | null>;
  clearSpec: (key: string) => void;
}
```

Cache key: a stable string derived from the `ContractSpecSource` — for `url`, the URL itself; for `inline`, a cheap hash (e.g. length + first 64 chars, or a proper SHA-256 via `crypto.subtle.digest` for collision safety); for `file`, the absolute path. The store is NOT persisted (no `persist` middleware) — specs are re-loaded on app restart since they can be large and the source may change externally.

### 8.3 New hook: `useDriftValidation`

**File:** `src/features/contracts/hooks/useDriftValidation.ts`

This hook wires the passive validation trigger. It is called from `ResponseViewer` (the earliest point where the response is in the React tree):

```typescript
// Called from ResponseViewer
function useDriftValidation(
  response: Response | null,
  request: HttpRequest | null,
  collectionId: string | undefined
): DriftValidationState;
```

Logic:

1. Resolve the nearest `contractSpec` by walking from the request's parent folder up to the collection root (via `useCollectionStore`).
2. If `driftDetection.skip` on the request or `driftDetection.enabled === false` on the collection → return `{ skipped: true }`.
3. Call `useContractStore.getOrLoadSpec(source)` — returns cached result or triggers a load.
4. Call `findOperationById(spec, request.contractRef.operationId)` if `contractRef` is set, else `matchOperation(spec, request.method, request.url)`.
5. If no match → return `{ noMatch: true }`.
6. Call `validateResponse({ match, schemaDialect, status, headers, body, contentType })`.
7. Return the `ContractValidationResult` for the UI to render.

The hook runs in a `useEffect` triggered by `response?.id`. Validation is async; while pending, state is `{ loading: true }`.

### 8.4 Integration point in `ResponseViewer`

**File:** `src/components/shared/ResponseViewer.tsx`

Changes are additive. The component already holds `currentResponse = useActiveResponse()` and `activeTab_` (which carries the request reference via `useActiveTab()`). The `useDriftValidation` hook is called near the top of `ResponseViewer`:

```typescript
const driftState = useDriftValidation(currentResponse, activeRequest, collectionId);
```

The drift badge is rendered in the existing Floater header bar (line ~80 in the file, in the stats row). The `'contract'` value is appended to the `ResponseTab` type and a new `TabsContent` block added.

### 8.5 Drift result storage in `useRequestStore`

**File:** `src/store/useRequestStore.ts`

The drift result is transient tab session state — it does not need to survive a page refresh. A new field `driftResult` is added to the per-tab state alongside `scriptResult`:

```typescript
// In tab state
driftResult?: {
  state: 'loading' | 'no-spec' | 'no-match' | 'pass' | 'error' | 'skipped';
  result?: ContractValidationResult;
  operationId?: string;
  specLabel?: string; // e.g. filename or URL truncated
};
```

The `setDriftResult` action updates this field. `useDriftValidation` calls `setDriftResult` after each validation completes. History items do NOT store drift results — they are recalculated on demand if the user loads a history response (and the spec is still available).

### 8.6 Spec loading security

**File:** `src/features/contracts/lib/specLoader.ts:110-118`

The existing `fetchSpecUrl` function at line 110 does a bare `fetch(url)` with no SSRF guard:

```typescript
async function fetchSpecUrl(url: string): Promise<string> {
  const res = await fetch(url, { ... });
  ...
}
```

This is a security gap for the URL spec source. The fix: before calling `fetch(url)`, validate the URL through the existing SSRF validator. In the renderer, this means calling `validateURL` from `src/features/http/lib/urlValidator.ts` (which wraps the shared URL validation logic) with `allowLocalhost: false` (spec URLs should be public or internal, but not arbitrary localhost targets the renderer can hit directly). **This fix is a prerequisite for the feature, not optional.**

Inline and file sources do not have SSRF exposure: inline is already-loaded text; file sources route through IPC (`electron/main` reads the file — a separate controlled path).

### 8.7 `CollectionSettingsDialog` additions

**File:** `src/features/collections/components/CollectionSettingsDialog.tsx`

Add a "Drift detection" toggle (checkbox) to the Contract tab. Saves to `collection.driftDetection.enabled` or `folder.driftDetection.enabled`.

### 8.8 `RequestSettingsEditor` additions

**File:** `src/features/http/components/RequestSettingsEditor.tsx`

Add an "Operation ID" picker (dropdown, populated from `useContractStore` when the parent collection has a spec) and a "Skip drift detection" toggle. These write to `HttpRequest.contractRef.operationId` and the new `HttpRequest.driftDetection?.skip` field.

### 8.9 Backend-agnostic guarantee

No changes to any of the following:

- `shared/protocol/http-proxy.ts`
- `shared/protocol/types.ts`
- `worker/` (Cloudflare Worker)
- `worker/node-entry.ts` (self-host)
- `electron/main/` (Electron IPC handlers)

The feature is entirely a renderer concern. It consumes the same `Response` object that all three backends already produce.

---

## 9. Security Considerations

### 9.1 SSRF via spec URL (must fix)

As noted in section 8.6: `specLoader.ts:fetchSpecUrl` at line 110 currently fetches arbitrary URLs without SSRF validation. A malicious collection (e.g. shared via an import) could set `contractSpec.url` to `http://169.254.169.254/latest/meta-data/` (AWS metadata endpoint) and trigger an SSRF from the renderer.

**Mitigation (required before shipping):** Route URL-source spec fetches through the same SSRF validation as regular requests:

- On web: the spec URL should be fetched via the Worker proxy (`/api/proxy`), not directly from the renderer — this is the same SSRF-guarded path that `shared/protocol/url-validation.ts` protects.
- On desktop: call `shared/protocol/url-validation.ts::validateUrl` (via the existing `urlValidator.ts` wrapper in the renderer) before the `fetch`.
- Both platforms already have this capability; this is a call-site discipline fix, not new infrastructure.

### 9.2 Spec contents as attack surface

The spec is parsed by `@apidevtools/swagger-parser` with `{ resolve: { external: false } }` (already set in `specLoader.ts:77`). This prevents the parser from following `$ref` URLs to arbitrary external resources. No change needed.

### 9.3 Secrets in specs

OpenAPI specs can contain example values, API keys in `securitySchemes`, or sensitive server URLs. The spec is stored only in the `useContractStore` in-memory cache — it is NOT persisted to Dexie or electron-store, and NOT included in collection exports (the `contractSpec` field stores only the source pointer: URL, path, or inline text; the parsed spec object stays in memory). The inline source case is the one risk: if the user pastes a spec inline, that text is persisted as part of `Collection.contractSpec.inline`. The existing `collection-export-redactor.ts` and `keyvalue-secret-redaction.ts` do not strip `contractSpec.inline`. **[assumption: inline spec content does not routinely contain secrets; this is acceptable for v1 but should be documented as a caveat.]**

### 9.4 Large spec DoS

A malicious spec with deeply nested `$ref` cycles or pathological schema complexity could cause Ajv to spin. Mitigations: the `$ref` deref with `external: false` already prevents cyclic external refs; Ajv's `strict: false` is set (no strict-mode panic); add a 5-second `AbortSignal` timeout to `loadContractSpec` for the URL fetch; validate response body only up to 1 MB (see FR-08).

---

## 10. Data Model and Persistence

### 10.1 Type system additions

**File:** `src/types/collection.ts`

```typescript
// Add to Collection and CollectionItem:
driftDetection?: {
  enabled: boolean; // default true when contractSpec is set
};
```

**File:** `src/types/http.ts`

```typescript
// Add to HttpRequest:
driftDetection?: {
  skip: boolean; // default false
};
```

`contractRef?: { operationId: string }` already exists in `HttpRequest` at line 65 — no change needed.

### 10.2 Zustand store: `useContractStore` (new, not persisted)

**File:** `src/features/contracts/store/useContractStore.ts`

In-memory only. No Dexie table. No `persist` middleware. Specs are re-loaded on app restart from their source (URL/inline/file). Cache size is bounded by the number of distinct specs attached to collections — in practice a small number.

### 10.3 Zustand store: `useRequestStore` (additive change)

**File:** `src/store/useRequestStore.ts`

Add `driftResult` to the per-tab state shape (see section 8.5). This is in-memory only alongside `scriptResult`. Not persisted.

### 10.4 `store-validators.ts` (no change required)

**File:** `src/lib/shared/store-validators.ts`

The `driftDetection` fields on `Collection`, `CollectionItem`, and `HttpRequest` are optional. The existing Zod schemas in `validations.ts` are used for import validation of collections. Add `driftDetection: z.object({ enabled: z.boolean() }).optional()` to `collectionSchema` and `contractRef` schema, and `driftDetection: z.object({ skip: z.boolean() }).optional()` to `httpRequestSchema`. These are additive and backward-compatible.

### 10.5 Database version (no change required)

No new Dexie table. The database version stays at 13. The new optional fields on `Collection` and `HttpRequest` are backward-compatible with existing persisted data (missing fields default to their natural values).

### 10.6 History items

Drift results are NOT persisted in `HistoryItem`. If a user views a historical response, the drift state is either recomputed (if the spec is still available) or shown as "Spec not loaded" (if the spec source is no longer reachable). This is intentional: drift against an older spec version would be misleading.

---

## 11. Capability Matrix Impact

### Platform parity

Drift detection is **platform-neutral** — it runs entirely in the renderer using the same code path on web, self-host, and desktop. No capability entry is needed in `src/lib/shared/capabilities.ts` because the feature is available on all platforms.

Exception: the `file` source for `ContractSpecSource` is already declared as desktop-only in `specLoader.ts:121-130` ("File-source specs are only supported in the desktop app"). This pre-existing constraint does not change. A file-source spec attached to a collection loaded in the web client will produce a clear error message from `loadContractSpec`, and the drift badge will show "Spec load error."

### `capabilities.ts` and `CAPABILITY_MATRIX.md`

No changes to `src/lib/shared/capabilities.ts`. Therefore `npm run capabilities:check` and `npm run capabilities:matrix` do not need to be re-run as part of this feature.

---

## 12. Acceptance Criteria and Test Plan

### 12.1 Vitest unit tests

**New file:** `src/features/contracts/hooks/__tests__/useDriftValidation.test.ts`

| Test case                                                                                        | Expected                                                                                           |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Request in collection with inline spec, valid 200 response                                       | `driftResult.state === 'pass'`                                                                     |
| Request in collection with inline spec, response has extra field + `additionalProperties: false` | `driftResult.state === 'error'`, 1 error with path `''` or `/fieldName`                            |
| Request in collection with inline spec, missing required field in response body                  | `driftResult.state === 'error'`, error keyword `'required'`                                        |
| Request in collection with inline spec, status 201 not declared (only 200 in spec)               | `driftResult.state === 'error'`, error keyword `'status'`                                          |
| Request in collection with inline spec, correct status but wrong content-type                    | `driftResult.state === 'error'`, error keyword `'content-type'`                                    |
| Request in collection with inline spec, required header missing                                  | `driftResult.state === 'error'` (or `'warning'` per severity mapping), keyword `'required-header'` |
| Request in collection with inline spec, valid response                                           | `driftResult.state === 'pass'`                                                                     |
| Request NOT in a collection (standalone tab)                                                     | `driftResult.state === 'no-spec'`                                                                  |
| Request in collection with NO spec attached                                                      | `driftResult.state === 'no-spec'`                                                                  |
| Request in collection, spec loaded, URL does not match any operation                             | `driftResult.state === 'no-match'`                                                                 |
| Request with `contractRef.operationId` set, valid match                                          | Uses `findOperationById`, state `'pass'`                                                           |
| Request with `driftDetection.skip === true`                                                      | `driftResult.state === 'skipped'`                                                                  |
| Collection with `driftDetection.enabled === false`                                               | `driftResult.state === 'skipped'`                                                                  |
| OpenAPI 3.1 spec (2020-12 dialect)                                                               | Schema dialect correctly set to `'2020-12'`, validation uses 2020 Ajv                              |
| GraphQL request (type `'graphql'`, method `'POST'`) with OpenAPI spec declaring `POST /graphql`  | Auto-matched, body validated as JSON                                                               |
| Response body > 1 MB                                                                             | Validated against first 1 MB, result notes truncation                                              |
| `useContractStore`: second call with same source key                                             | Returns cached result without calling `loadContractSpec` again                                     |
| SSRF guard on URL spec source: `http://169.254.169.254/...`                                      | `loadContractSpec` returns error, no HTTP fetch attempted                                          |

**Extend existing file:** `src/features/contracts/lib/__tests__/validator.test.ts`

Add edge-case coverage for:

- `additionalProperties: false` drift (extra field in response)
- `nullable: true` OpenAPI 3.0 handling (`type: ['string', 'null']` in 3.1)
- Body is `null` when spec declares an object — should produce a type error

**New file:** `src/features/contracts/lib/__tests__/operationMatcher.test.ts` (already exists; add):

- URL with query params stripped before matching
- Server base path stripping (`servers[0].url = 'https://api.example.com/v2'`)

### 12.2 Playwright e2e tests

**New file:** `e2e/spec-drift-detection.spec.ts`

Prerequisites: the echo Worker at `echo/` is the controlled upstream. It needs a new `/drift-test` endpoint that returns a JSON object. The test:

1. Starts the dev server (via existing `webServer` Playwright config).
2. Creates a collection with an inline OpenAPI spec declaring `GET /drift-test` returns `{ id: integer, name: string }`.
3. Sends `GET /echo/drift-test` which returns `{ id: "not-an-integer", name: "alice", unexpected_field: true }`.
4. Asserts that the drift badge appears in the response header with error count.
5. Clicks the "Contract" tab.
6. Asserts that the error list contains the type error on `/id`.
7. Sends the same request after toggling "Skip drift detection" on the request — asserts badge is hidden.

### 12.3 Security tests

**New file:** `tests/security/spec-drift-ssrf.test.ts`

| Test                                                                        | Expected                                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ContractSpecSource` with `url: 'http://169.254.169.254/latest/meta-data/'` | `loadContractSpec` returns `{ ok: false, stage: 'load', error: <SSRF rejection> }` |
| `ContractSpecSource` with `url: 'http://10.0.0.1/openapi.yaml'`             | Same rejection for RFC-1918                                                        |
| `ContractSpecSource` with `url: 'file:///etc/passwd'`                       | Rejected by URL scheme check before SSRF guard                                     |

---

## 13. Success Metrics

| Metric                                                                                 | Target                                      | Measurement                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| Adoption (% of active collections with a spec attached)                                | 20% of collections within 60 days of launch | `useCollectionStore` telemetry (opt-in)                                 |
| Validation latency (p50 time from response received to badge rendered)                 | < 50 ms                                     | Renderer performance mark `drift-validate-start` → `drift-validate-end` |
| False positive rate (user clicks "Skip drift" or removes spec within 30 s)             | < 5% of validations                         | Telemetry event `drift_skipped_immediately`                             |
| Spec load error rate (URL/inline spec fails to load)                                   | < 2% of load attempts                       | `drift_spec_load_error` telemetry event                                 |
| Feature awareness (% of users with a spec-attached collection who have seen the badge) | 80% within 30 days                          | First `drift_badge_seen` event                                          |

---

## 14. Rollout Phases

### Phase 1 (v1 — minimal, this PRD)

- Core wiring: `useDriftValidation` hook + `useContractStore` + drift badge in `ResponseViewer`.
- Contract tab with flat error list.
- Opt-out at collection and request level.
- SSRF fix in `specLoader.ts:fetchSpecUrl` (prerequisite).
- Automatic URL+method matching plus explicit `contractRef` pin.
- Unit and e2e test coverage.

### Phase 2 (v2 — depth and breadth)

- **AsyncAPI support:** Validate Kafka/MQTT/WebSocket messages against AsyncAPI 2.x/3.x schemas. Adds `loadAsyncApiSpec` and `validateAsyncApiMessage` alongside the existing OpenAPI path.
- **File source in desktop:** Implement the `fetchSpecFile` IPC path in `specLoader.ts:121` (currently throws `'not yet implemented'`). Adds a new IPC channel and Electron `fs.readFile` handler.
- **CLI drift reporting:** Integrate drift check into `@restura/cli` collection runner, adding a `--drift` flag that fails the run on any drift errors.
- **Severity tiering:** Add `deprecated` and `info` severity for deprecated operations and informational schema annotations.
- **History drift replay:** Recompute drift for history items on demand (if the spec is still loaded) with a "Re-validate" button in the history panel.
- **GraphQL schema validation:** Validate query responses against GraphQL introspection schema (separate schema type from OpenAPI; requires `graphql` package in renderer).
- **JSON Pointer highlight:** Clicking a body error path highlights that token in the Monaco response body editor using `responseEditorRef` decorations.
- **Drift badge in collection runner results:** Show per-request drift summary in the collection run results panel.

---

## 15. Risks and Open Questions

### R-01: `useContractStore` in-memory-only spec cache may be too large for specs with many inline examples

**Risk:** An OpenAPI spec with hundreds of example values or large binary schemas could occupy tens of MB in the parsed (dereferenced) form. With multiple specs loaded, memory pressure may degrade the renderer.

**Mitigation:** LRU-evict the in-memory spec cache when total entry count exceeds a configurable cap (default: 5 specs). Force-reload on next access. Mark for v2 if not hit in practice.

### R-02: URL-based auto-matching is fragile for multi-server or parameterized server URLs

**Risk:** `matchOperation` strips `servers[*].url` prefixes using a best-effort parse (`src/features/contracts/lib/operationMatcher.ts:181-200`). If the user's environment substitutes a variable server URL (e.g. `https://{{host}}/api`), the unresolved template won't match.

**Mitigation:** Resolve environment variables in the spec's `servers[*].url` at load time using the same `resolveVariables` mechanism used for request URLs. **[assumption: this requires passing the current environment vars to `useContractStore.getOrLoadSpec`.]** Deferred to v2 if it proves complex.

### R-03: `specLoader.ts:fetchSpecUrl` is currently a bare `fetch` — no auth

**Risk:** URL-source specs behind bearer auth (e.g. a private API portal) fail to load.

**Mitigation:** v1 does not support auth on spec URL fetches. Users must use inline paste or provide a publicly accessible URL. Explicit non-goal. v2 can add a "spec auth" field to `ContractSpecSource`.

### R-04: Active tab does not carry `collectionId` in current state shape

**[assumption]** The `useDriftValidation` hook needs to know which collection the active request belongs to, to resolve the `contractSpec` inheritance chain. It is unclear from the current `useRequestStore` state shape whether tabs carry `collectionId` directly or whether this requires a lookup from `useCollectionStore`. This needs clarification from the store shape before implementation begins.

**Mitigation:** If `collectionId` is not on tab state, the hook can scan `useCollectionStore.collections` to find the collection containing the active request's ID. This is a linear scan but is bounded by collection count (typically < 100).

### R-05: Inline spec persistence in collection export leaks spec content

**Risk:** A collection export (OpenCollection or Postman format) would include the full text of an inline spec in `contractSpec.inline`. For large or sensitive specs, this is unexpected.

**Mitigation:** Document this behavior in release notes. v2 can add a "strip spec from export" option in the export dialog.

### Open Questions

- **OQ-01:** Should the drift badge appear on responses from standalone (non-collection) requests that the user has locally attached a spec to ad-hoc? Or is spec attachment always collection-scoped? (Current type model: collection-scoped only. Recommend keeping it that way in v1 for simplicity.)
- **OQ-02:** When `contractRef.operationId` is set but `findOperationById` returns null (the spec no longer contains that operation — e.g. after a spec update), should the system fall back to URL matching, or show a "stale pin" warning?
- **OQ-03:** Should drift errors be surfaced in the test script result (as a synthetic assertion) so they appear alongside `rs.*` test results? This would unify the two result surfaces but risks confusing users who write their own contract assertions.

---

## 16. Round-2 Review Addendum (verified findings)

A second code-grounded review surfaced these items (round-1 symbol claims all re-confirmed accurate). Severity = impact if shipped unaddressed.

| #    | Tag         | Sev  | Finding                                                                                                                                                                                                      | Fix                                                                                                                                                           |
| ---- | ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | SECURITY    | High | `fetchSpecUrl` (`specLoader.ts:110`) has no timeout and follows redirects by default — a public spec URL can 30x-redirect to `http://169.254.169.254`. SSRF-validating only the initial URL is insufficient. | Add a 5 s `AbortSignal`; set `redirect: 'error'` (or re-validate the post-redirect URL); validate via the shared guard, not just the renderer `urlValidator`. |
| R2-2 | PARITY      | High | §8.1 ("renderer-only, no Worker changes") contradicts §8.6 (web must fetch specs through `/api/proxy` because the browser is CORS/network-bound).                                                            | Commit to: web routes spec fetch through the Worker proxy; state plainly it is **not** purely renderer-only on web. Desktop stays direct.                     |
| R2-3 | CONSISTENCY | Med  | `RequestTab` has no `collectionId` (`src/types/request.ts`), but `useDriftValidation` needs it to resolve the collection's `contractSpec` inheritance.                                                       | Either add `collectionId?: string` to `RequestTab`, or have the hook resolve the collection by scanning for `savedRequestId`. Document the choice in §10.     |
| R2-4 | FEASIBILITY | Med  | `ContractValidationError` (`validator.ts`) has no `severity` field, but §6/§7 render error vs warning badges.                                                                                                | Add `severity?: 'error' \| 'warning'`, or a UI mapping helper keyed by `keyword`.                                                                             |
| R2-5 | FEASIBILITY | Med  | Parameterized `servers[].url` (`https://{host}/v1`) breaks `matchOperation` base-path stripping in v1 → silent "no match".                                                                                   | Surface the limitation in the contract-tab empty state; defer env-resolved matching to v2 (already noted in §15).                                             |
| R2-6 | OVERCLAIM   | Low  | §13 "<50 ms p50" assumes a warm spec cache; cold parse+deref+Ajv-compile is ~26–130 ms.                                                                                                                      | Qualify the metric as "warm-cache p50"; track cold-cache separately.                                                                                          |
