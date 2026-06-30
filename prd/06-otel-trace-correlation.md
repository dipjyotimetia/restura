# PRD 06 — OpenTelemetry Trace Correlation

**Status**: Draft  
**Author**: Product  
**Date**: 2026-06-30  
**Target release**: v1 — Desktop + Self-host (see Capability Matrix section)

---

## 1. Summary

When a user sends an HTTP request, Restura injects a W3C `traceparent` header. After the response arrives, Restura queries a configured distributed-tracing backend (Grafana Tempo or Jaeger in v1) using that trace ID and renders a server-side latency waterfall inline inside the response panel. This transforms the experience from "I see 800 ms total round-trip" into "here are the five downstream spans and the database call that consumed 600 ms of it." The feature is a read-only correlation layer — Restura generates the trace ID and queries the trace; it does not run an OTel SDK, create spans of its own, or manage instrumented services.

---

## 2. Problem & Evidence

### The Problem

API client users — particularly backend engineers debugging latency regressions — today see only the total round-trip time reported in the Restura response panel (rendered via `formatBytes`/`formatClockTime` helpers in `src/lib/shared/console-format.ts`). When a request takes 800 ms, the client cannot distinguish between a slow network, a slow application server, a slow database query, or a slow downstream microservice call. Engineers must context-switch out of the tool, open Grafana Tempo or Jaeger UI, search for a trace by timestamp and endpoint, and manually cross-reference it with the request they just fired.

### Market Evidence

W3C Trace Context (`traceparent` header, https://www.w3.org/TR/trace-context/) reached Recommendation status in 2020 and is now natively supported by every major OTel-instrumented framework. Grafana Tempo and Jaeger both expose stable query APIs for fetching traces by trace ID. OTel matured considerably in 2024-2025: https://opentelemetry.io/docs/concepts/context-propagation/ is widely implemented across language SDKs.

Verification against current API client documentation (June 2026):

- **Postman**: No `traceparent` injection; no trace query or waterfall feature in the HTTP response panel. (https://learning.postman.com/docs/sending-requests/response-data/responses/)
- **Insomnia**: No distributed trace correlation feature. (https://docs.insomnia.rest/)
- **Bruno**: No OTel trace correlation in the response panel. (https://docs.usebruno.com/)

This is verified-absent across documented feature sets, not provably exhaustive (undocumented betas may exist). The gap appears real, and the architecture positions Restura well to fill it: the Electron main process and the Node self-host entry can make outbound trace-backend queries without CORS friction that would block a pure browser app. However, **demand for this specific workflow is unvalidated** — we have no survey data, no discovery interviews, and no user voice confirming engineers would use this inside their API client rather than in a dedicated APM UI. This is a capability bet ranked on certainty-of-gap, not proven heat.

**Recommendation: run a cheap validation spike before committing to full build** (see Rollout Phases, section 14).

---

## 3. Goals / Non-Goals

### Goals (v1)

- Inject a spec-compliant W3C `traceparent` header (format: `00-{32-hex-trace-id}-{16-hex-parent-id}-{flags-byte}`) on HTTP requests where the user has opted in, per-request or per-environment.
- Support Grafana Tempo as the primary backend (HTTP query API: `GET /api/traces/{traceId}`).
- Support Jaeger as the secondary backend (HTTP query API: `GET /api/traces/{traceId}`).
- Fetch the corresponding trace from the configured backend after the response arrives; retry with backoff to handle trace-indexing lag.
- Render a server-side latency waterfall in a new "Trace" tab in the response panel, inline alongside the existing response body / headers tabs.
- Store the tracing backend configuration (endpoint, auth) per Environment, so teams can configure different backends for dev/staging/prod.
- Gate behind a feature flag for the validation spike so no user sees it until validated.

### Non-Goals (v1)

- Restura does not run an OTel SDK. It does not create spans for its own operations.
- No APM functionality (metrics, logs, alerts, anomaly detection).
- No support for OTLP/gRPC trace query protocol in v1 (HTTP REST query APIs only).
- No support for Zipkin, Datadog, AWS X-Ray, or Honeycomb in v1.
- No `tracestate` header injection beyond the `traceparent` (vendors may add `tracestate` in v2).
- No trace-aware diff or comparison between two requests.
- No mutation of the trace backend (Restura is read-only against the trace store).
- GraphQL, gRPC, SSE, WebSocket, MCP, Kafka, MQTT protocols are out of scope for v1 (HTTP only, since those paths don't go through `executeHttpProxy`).

---

## 4. Target Users and Top Use Cases

### Primary Target: Backend and Platform Engineers

Engineers who already run OpenTelemetry-instrumented services (Spring Boot, Go, Python Flask, Node.js with OTel auto-instrumentation) and use Restura to fire manual HTTP requests during development, debugging, or incident triage. They have Tempo or Jaeger deployed and accessible.

**Use case 1 — Latency debugging**: An engineer fires a `POST /api/orders` request that returns 200 OK in 1.2 s. The Trace tab shows a 900 ms span for a downstream payment-service call with a 400 ms database query inside it. The engineer immediately pinpoints the bottleneck without leaving the tool.

**Use case 2 — Regression catching during development**: An engineer is building a new API endpoint and fires exploratory requests. Each response shows the trace waterfall, making span regressions visible immediately in the iteration loop, before CI.

**Use case 3 — Incident triage**: An on-call engineer fires the failing request, sees in the waterfall that a specific Redis call is timing out (large red span), and correlates the timing with a Redis cluster issue without opening three separate tools.

### Secondary Target: QA Engineers Running Collections

Engineers who run Restura collections via the CLI or the collection runner to smoke-test deployed services. Trace IDs could be attached to history entries, enabling post-run trace review. (Collection runner integration is post-v1.)

---

## 5. User Stories

**US-01** — As a backend engineer, I want to toggle `traceparent` injection per HTTP request so that I can opt in only for requests where I have a corresponding OTel backend configured, without polluting all my requests with an unknown header.

**US-02** — As a team lead, I want to configure the tracing backend (Tempo endpoint + auth token) at the Environment level so that my team's shared dev environment config automatically points to the right Tempo cluster without each engineer configuring it individually.

**US-03** — As a debugging engineer, I want to see the distributed trace waterfall as a new "Trace" tab in the response panel, appearing automatically after `traceparent` injection, so that the trace data is co-located with the HTTP response without any additional clicks.

**US-04** — As a debugging engineer, I want the trace waterfall to show each span's service name, operation name, start offset, and duration as a horizontal bar, ordered by start time, so that I can visually identify the slowest spans at a glance.

**US-05** — As a cautious engineer, I want trace injection to be opt-in and off by default so that I never accidentally inject headers into production requests without understanding what they do.

**US-06** — As an engineer whose trace backend has auth, I want to store the auth token as a SecretRef (never plaintext in the environment config) so that the token never appears in exported collections or error logs.

**US-07** — As an engineer hitting a trace backend on a private network (e.g., `http://tempo.internal:3200`), I want this to work from the desktop client without workarounds, because the Electron main process can reach internal hosts that the browser cannot.

**US-08** — As a user, I want a clear message in the Trace tab when no trace was found (e.g., the service is not instrumented for OTel, or the sampling rate dropped this request) rather than a silent empty state.

---

## 6. Functional Requirements

### FR-01: `traceparent` Header Injection

- The system MUST generate a spec-compliant W3C `traceparent` value: `00-{32-hex-trace-id}-{16-hex-parent-id}-{01}`. The trace ID is a 128-bit random value (16 bytes, 32 hex chars). The parent span ID is a 64-bit random value (8 bytes, 16 hex chars). Flags byte is `01` (sampled=true) when injection is enabled.
- **[assumption]** Flags byte is always `01` in v1 (we are always requesting the service to sample this trace). A "request not sampled" flag (`00`) is out of scope — v1 does not need sampling control from the client side; if the service's sampler drops it, the trace simply won't appear and we show the "no trace found" state.
- Injection MUST be controlled by a per-request toggle (`otel.inject: boolean`) on `RequestSpec` (`shared/protocol/types.ts`) AND by an environment-level default (see FR-04). Per-request setting takes precedence; if absent, falls back to environment default.
- The header MUST be added to the outgoing request AFTER `sanitizeRequestHeaders` (which strips hop-by-hop headers via `REQUEST_DENY` in `shared/protocol/header-policy.ts`) and BEFORE `followRedirects`. The `traceparent` header is not in `REQUEST_DENY` (currently `host`, `connection`, `content-length`, `transfer-encoding`, `upgrade`, `proxy-connection`, `proxy-authenticate`, `proxy-authorization`) so no allowlist change is needed for injection. However, the system MUST NOT re-inject a new `traceparent` if the user has already manually set one in `spec.headers` (user-supplied header wins).
- The generated trace ID MUST be returned to the renderer so it can be displayed and used for the trace query. It is added to `NormalizedResponse` (`shared/protocol/types.ts:152`) as `otelTraceId?: string`.
- Injection occurs in `shared/protocol/http-proxy.ts` in the `executeHttpProxy` function, before the `followRedirects` call at line 122, so it is backend-agnostic and runs identically across the Worker, Node self-host, and Electron.

### FR-02: Trace Backend Configuration

- Configuration is stored per Environment as an `OtelConfig` object (see Data Model, section 10).
- Fields: `backendKind` (`'tempo' | 'jaeger'`), `endpoint` (string URL), `auth` (`ProtocolSecretValue` using the existing `SecretRef` pattern from `shared/protocol/secret-value-schema.ts`), `enabled` (boolean).
- The endpoint URL is validated through `validateURL` from `shared/protocol/url-validation.ts` at config-save time. The Electron path additionally validates through the dedicated **`assertOtelBackendSafe(url, { allowPrivateIPs })`** guard at query time (see §8.3 — `assertUrlHostnameSafe` cannot be reused because it hard-codes `allowPrivateIPs: false`).

### FR-03: Trace Fetch After Response

- After the response arrives and `otelTraceId` is present in `NormalizedResponse`, the renderer dispatches a trace fetch request to the backend (IPC on Electron, `/api/otel-trace` route on Worker/self-host).
- The backend fetches `GET {endpoint}/api/traces/{traceId}` (Tempo/Jaeger both share this path in their HTTP query APIs) with the configured auth header. **[assumption]** Tempo and Jaeger use `Authorization: Bearer {token}` for auth in v1; OAuth2 and mutual-TLS variants are out of scope.
- Because traces may not be indexed immediately, the backend MUST retry up to 3 times with delays of 1 s, 2 s, 4 s (exponential backoff, total ceiling 7 s) before returning a "not found" result. The renderer shows a loading state in the Trace tab during this window.
- The trace fetch MUST NOT block the display of the HTTP response. The response body, headers, and status code are rendered immediately; the Trace tab shows a spinner until the fetch resolves.
- If the trace backend query fails (non-2xx, network error, timeout), the Trace tab shows a non-blocking error state with the failure reason. It MUST NOT propagate errors to the main response result.

### FR-04: Environment-Level OTel Config

- Each Environment in the environment store gains an optional `otel?: OtelConfig` field.
- `OtelConfig.enabled` acts as the environment-level default for `otel.inject`. If `true`, all HTTP requests using that environment inject `traceparent` unless per-request opt-out is set.
- The Environments editor gains an "OTel Tracing" section (collapsed by default) where the user configures the backend.

### FR-05: Waterfall Rendering

- The "Trace" tab displays each span as a labeled horizontal bar proportional to its duration relative to the root span.
- Required per-span fields: service name, operation/span name, start offset (ms from root span start), duration (ms), status (OK / ERROR / UNSET).
- Spans are sorted by start time ascending.
- The root span is visually distinguished (bold label, full-width bar baseline).
- Error spans (OTel status ERROR) are rendered in red.
- Hovering a span shows a tooltip with the full span ID, parent span ID, and any available span attributes (key-value pairs).
- Maximum spans rendered in v1: 200 (to bound DOM complexity). If the trace has more, a notice is shown.

### FR-06: No-Trace State Handling

- If the trace is not found after retries: "No trace found for this request. The service may not be instrumented with OTel, or this request may have been dropped by the sampler."
- If OTel is enabled but no backend is configured: "Configure a tracing backend in the active Environment to see distributed traces."
- If `traceparent` injection was off for this request: the Trace tab is absent (not shown at all).

---

## 7. UX and Flows

### Toggle Placement

**Per-request**: In `RequestSettingsEditor.tsx` (`src/features/http/components/RequestSettingsEditor.tsx`, 25.6 KB — the existing per-request settings panel), add a collapsible "Tracing" section with a single toggle: "Inject traceparent header". When toggled on, it overrides the environment default.

**Environment-level**: In the Environment editor, add an "OTel Tracing" card:

- Enable OTel (checkbox)
- Backend: [Tempo | Jaeger] (select)
- Endpoint: (URL input, e.g. `https://tempo.mycompany.com`)
- Auth Token: (secret input using the existing SecretRef input pattern)

### Response Panel Trace Tab

The Trace tab appears as a fourth tab in the response panel (after Body, Headers, Cookies) only when `traceparent` was injected on the request that produced the visible response entry.

```
[Body] [Headers] [Cookies] [Trace]
                                   ^--- new tab, only when OTel was injected
```

### ASCII Waterfall Wireframe

```
TRACE  4bf92f3577b34da6a3ce929d0e0e4736      fetched in 1.2s
----------------------------------------------------------------
Service          Operation              |0ms       |400ms  |800ms
----------------------------------------------------------------
api-gateway      POST /api/orders       |=======================================================|  812ms
order-service    processOrder           |  ===============================================|  740ms
payment-service  chargeCard             |           ========================|  310ms  [ERROR]
db-postgres      query orders           |  ==========|  95ms
cache-redis      GET order:cache        |===|  12ms
----------------------------------------------------------------
Root span start: 2026-06-30T14:22:01.003Z    Total: 812ms

  [!] payment-service/chargeCard — ERROR
      db.statement: SELECT * FROM charges WHERE...
      error.message: connection timeout after 300ms
```

Notes on the wireframe:

- Bars are proportional (the root span always spans the full width).
- Service name and operation name are in separate columns.
- ERROR spans show `[ERROR]` suffix and red bar color.
- Tooltip (on hover) expands span attributes (shown in the wireframe as the bottom section for illustration).

---

## 8. Architecture and Implementation

### 8.1 Header Injection — Shared Protocol Layer

**Why shared protocol**: Injection must happen in `shared/protocol/http-proxy.ts` (not the renderer, not the backend fetcher) because `shared/protocol/` is the single backend-agnostic orchestration layer that runs identically on the Worker, Node/Docker entry, and Electron. Injecting at this level means one implementation, three backends, zero parity drift — the same discipline that led to the existing `REQUEST_ID_HEADER` / `ensureRequestId` pattern at `shared/protocol/types.ts:138-150`.

**Exact change in `shared/protocol/types.ts`**:

- Extend `RequestSpec` (line 88) with an optional `otel?: { inject: boolean }` field.
- Extend `NormalizedResponse` (line 152) with `otelTraceId?: string`.

**Exact change in `shared/protocol/http-proxy.ts`**:

- After `sanitizeRequestHeaders` (line 80) and before `followRedirects` (line 122), insert the injection block: check `spec.otel?.inject === true`, check whether `traceparent` is already present in `headers` (case-insensitive), if absent generate `00-{randomTraceId}-{randomParentId}-01` using `crypto.randomUUID()`-derived bytes (available in all three runtimes), inject it, stash `traceId` in a local variable.
- After the response is assembled into `normalized` (line 200), attach `normalized.response.otelTraceId = traceId`.

**No changes needed to `header-policy.ts`**: `traceparent` is not in `REQUEST_DENY`; it passes sanitization unchanged.

### 8.2 Trace Fetch — Backend-Only, Not Renderer

**Why not in the renderer**: Three concrete blockers:

1. **CORS**: Tempo and Jaeger do not typically serve `Access-Control-Allow-Origin: *` on their query APIs. A browser `fetch()` call from the renderer would be CORS-rejected. The backend fetchers (Worker `globalThis.fetch`, Node `fetch`, Electron `undici`) are not subject to CORS — they are server-side HTTP clients.
2. **Auth**: If the tracing backend uses a bearer token stored as a `SecretRef { kind: 'handle' }`, the plaintext is only resolvable in the Electron main process via `unwrapSecretValueMain` in `electron/main/security/secret-handle-store.ts`. The renderer never sees the plaintext.
3. **SSRF gate**: Any new outbound URL must be validated by the backend SSRF guards before the network call is made. The renderer has no role in enforcing `validateURL` + `assertUrlHostnameSafe`.

**Implementation path per backend**:

| Backend               | New surface                                                                                           | Trace fetch mechanism                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Electron desktop**  | New IPC channel `otel:trace:fetch` registered in a new `otel-handler.ts` in `electron/main/handlers/` | `makeFetchFetcher` (from `electron/main/handlers/fetch-fetcher.ts`) after `assertOtelBackendSafe(url, { allowPrivateIPs })` (new `electron/main/security/otel-backend-guard.ts`, see §8.3 — NOT `assertUrlHostnameSafe`) |
| **Node self-host**    | New Hono route `/api/otel-trace` in `worker/app.ts`                                                   | `globalThis.fetch` (Node 24 has built-in fetch); same pattern as the `/api/proxy` handler in `worker/handlers/proxy.ts`                                                                                                  |
| **Cloudflare Worker** | Same `/api/otel-trace` route, conditional on `ENVIRONMENT` and allowlist                              | `globalThis.fetch` via Cloudflare Sockets or direct fetch; only viable if Tempo is publicly accessible — see Capability Matrix                                                                                           |

The IPC handler on Electron uses `createValidatedHandler` from `electron/main/ipc/ipc-validators.ts` (same pattern as `HttpRequestConfigSchema`) for input validation. Rate limiting via `createKeyedRateLimiter` from `electron/main/ipc/ipc-rate-limiter.ts`.

**Polling / retry**: The handler executes up to 3 fetch attempts with 1 s, 2 s, 4 s sleeps between them. `AbortSignal` with a 10 s ceiling is threaded through to allow the renderer to cancel if the user navigates away.

### 8.3 Web vs. Self-Host vs. Desktop Parity

**Desktop (Electron)**: Full support, but **`assertUrlHostnameSafe` cannot be reused as-is** — it hard-codes `allowPrivateIPs: false` (`dns-guard.ts:60`), so it would block every private Tempo/Jaeger endpoint (10.x.x.x, `tempo.internal`, …), contradicting this row. Instead add a **dedicated guard `assertOtelBackendSafe(url, { allowPrivateIPs })`** mirroring the existing **`kafka-broker-guard.ts` / `mqtt-broker-guard.ts`** pattern (they call `validateURL` directly with `allowPrivateIPs: true`, accepting the documented TTL=0 DNS-rebind residual risk). `allowPrivateIPs` is threaded from the environment's OTel config, never user-global. SecretRef handles are resolved by `unwrapSecretValueMain`. **[corrected after round-2 review]**

**Self-host (Node/Docker)**: Full support. Same as desktop regarding private-network access. The Node entry (`worker/node-entry.ts`) serves the `/api/otel-trace` route. Auth via Bearer token; SecretRef `kind: 'handle'` is NOT supported in the self-host path (the OS keychain is an Electron-only facility) — the config must use `kind: 'inline'` or an env-var-substituted string. **[assumption]**

**Web (Cloudflare Worker)**: Conditional support. The Worker CAN reach publicly accessible Tempo/Jaeger endpoints (e.g., Grafana Cloud Tempo). It CANNOT reach private-network Tempo (`tempo.internal`, `10.x`) because the Cloudflare Worker runs in Cloudflare's infrastructure, not the user's network. For this reason, **the tracing feature is desktop + self-host first**. The Worker route exists (for Grafana Cloud Tempo users) but the capability matrix reflects that private-network trace backends require desktop or self-host. The Worker path does not support `SecretRef { kind: 'handle' }` (consistent with all other Worker paths — the secret-handle-store is Electron-only).

**Capability entry** (new, added to `src/lib/shared/capabilities.ts`):

```
'http.otelTraceCorrelation': {
  label: 'OTel trace correlation (traceparent injection + waterfall)',
  web: true,    // public Tempo/Jaeger only; private backends blocked by CORS + routing
  desktop: true,
  notes: 'Private-network trace backends (tempo.internal, 10.x) require desktop or self-host. Web path supports public Grafana Cloud Tempo only.'
}
```

After editing `capabilities.ts`, regenerate: `npm run capabilities:matrix` and commit the updated `docs/CAPABILITY_MATRIX.md`.

### 8.4 Renderer (Trace Tab UI)

- New `TraceTab.tsx` component in `src/features/http/components/NetworkConsole/`.
- Lazy-loaded via `lazyComponent` (`src/lib/shared/lazyComponent.tsx`) — same pattern as `DiskTab` at `NetworkConsole/index.tsx:48`.
- Receives the `otelTraceId` from the response entry stored in `useConsoleStore`.
- Triggers the trace fetch IPC/HTTP call via a new hook `useOtelTrace(traceId, otelConfig)`.
- Renders the waterfall as a pure SVG or CSS-positioned bar chart (no canvas needed for 200 spans); uses Tailwind classes for theming.
- The Trace tab is conditionally shown in the tab list in `NetworkTab.tsx` only when the console entry has `otelTraceId`.

### 8.5 Trace Data Transform

A pure TypeScript function `transformTraceToWaterfall(traceJson: TempoTraceResponse | JaegerTraceResponse): WaterfallSpan[]` lives in `src/features/http/lib/otelTraceTransform.ts`. It normalizes both Tempo and Jaeger JSON wire shapes into a common `WaterfallSpan[]` array. This function is pure (no I/O, no DOM) and is the primary unit-test target (see Acceptance Criteria).

---

## 9. Security Considerations

### 9.1 New Outbound: Trace Backend Query

Every trace fetch is a new outbound HTTP request to a user-configured URL. This is the same threat surface as the existing proxy endpoint. Mitigations:

**Shared protocol SSRF guard** (`shared/protocol/url-validation.ts`): The trace backend endpoint is validated through `validateURL` with `allowLocalhost` derived from the environment config. Cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`) are blocked unconditionally. Private IP ranges are blocked unless `allowPrivateIPs` is explicitly set (desktop only, and user-controlled). This validation runs at config-save time (reject bad URL early) and at query time (defense in depth).

**Electron OTel backend guard** (new `electron/main/security/otel-backend-guard.ts`): `assertOtelBackendSafe(url, { allowPrivateIPs })` resolves the trace endpoint hostname and validates every resolved address before the TCP connect, mirroring the `kafka-broker-guard.ts` / `mqtt-broker-guard.ts` pattern (it calls `validateURL` directly so `allowPrivateIPs` can be threaded from the env OTel config). It is NOT `assertUrlHostnameSafe`, which hard-codes `allowPrivateIPs: false` and would block private Tempo/Jaeger. This is a pre-flight guard against DNS rebinding. Note: it does NOT mitigate TTL=0 DNS-rebind (per the existing comment at `dns-guard.ts:15`) — the same residual risk documented across all other handlers.

**Worker SSRF guard**: The Worker's Hono `/api/otel-trace` handler calls `validateURL` before the fetch, same as `/api/proxy` in `worker/handlers/proxy.ts`. No additional Worker-side DNS guard (the Worker has no `dns.lookup` — same limitation as all other Worker handlers).

### 9.2 Trace Backend Auth via SecretRef

The auth token for the trace backend MUST be stored as `ProtocolSecretValue` (from `shared/protocol/types.ts`) using the `SecretRef` pattern documented in ADR-0007. In the Electron path, the token is stored as a `{ kind: 'handle'; id }` in `electron/main/security/secret-handle-store.ts` and never touches the renderer, the Zustand store, or exported collections. In the self-host/Worker path (no OS keychain), the token is stored as `{ kind: 'inline'; value }` — the user should be warned in the UI that this is stored in the environment config.

When the environment is exported (Postman, Insomnia, OpenCollection), the OTel auth token MUST be redacted via the existing `collection-export-redactor.ts` pattern in `electron/main/security/`.

### 9.3 Trace Data Contains Sensitive Span Attributes

Distributed traces may carry sensitive information in span attributes: SQL queries, HTTP request bodies, internal service URLs, user IDs, session tokens. Mitigations:

- **No logging**: The raw trace JSON MUST NOT be written to the `request-logger.ts` JSONL on Electron, nor to Worker tail logs. Only the trace ID and fetch status (found/not-found/error) are logged.
- **No persistence**: The trace payload is ephemeral in the renderer — held in React component state, not persisted to Dexie/electron-store or the history entry. History entries store only `otelTraceId` (the 32-char string), not the full trace.
- **Display redaction**: The span attribute display in the tooltip (hover state) SHOULD NOT render raw `db.statement` or `http.request.body` attributes by default — these are shown in a collapsed, expandable section clearly labeled "Sensitive Attributes" so the user makes an active choice to expand them. **[assumption]**
- **No Sentry**: The trace payload MUST be excluded from any Sentry breadcrumbs or error context. Existing `scrubEvent` in `electron/main/lifecycle/sentry.ts` already drops `request/user/vars`; OTel trace data must be similarly excluded.

### 9.4 IPC Validation

The new `otel:trace:fetch` IPC channel on Electron MUST use `createValidatedHandler` from `electron/main/ipc/ipc-validators.ts` (same pattern as `HttpRequestConfigSchema`) to validate the incoming `traceId` (32 hex chars, no more, no less) and the resolved `endpoint` URL before any network I/O. This prevents a compromised renderer from injecting an arbitrary URL into a privileged network call.

---

## 10. Data Model and Persistence

### 10.1 OtelConfig (per Environment)

```typescript
// Proposed addition to src/types/settings.ts or a new src/types/otel.ts
export interface OtelConfig {
  enabled: boolean;
  backendKind: 'tempo' | 'jaeger';
  endpoint: string; // e.g. "https://tempo.mycompany.com"
  auth?: ProtocolSecretValue; // SecretRef or inline token
}
```

The `Environment` type (in whatever module defines it) gains `otel?: OtelConfig`. The Zod schema in `src/lib/shared/store-validators.ts` is updated to validate this shape.

**[assumption]** One OTel config per environment is sufficient for v1. Teams do not need multiple trace backends per environment.

### 10.2 RequestSpec Extension

```typescript
// Addition to shared/protocol/types.ts RequestSpec interface
otel?: {
  inject: boolean;  // per-request override; falls back to Environment OtelConfig.enabled
};
```

### 10.3 NormalizedResponse Extension

```typescript
// Addition to NormalizedResponse in shared/protocol/types.ts
otelTraceId?: string;  // the trace ID injected on this request; absent if injection was off
```

### 10.4 History Entry Extension

The history entry shape (in `useHistoryStore`) gains `otelTraceId?: string` — a lightweight reference. The full trace payload is NOT stored in history. When the user opens a historical response entry and it has an `otelTraceId`, the Trace tab is shown with a "Re-fetch trace" button (the trace may or may not still be in the backend's retention window). **[assumption]**

### 10.5 Caching

Trace data is cached in-memory for the current session (a simple `Map<traceId, WaterfallSpan[]>`) to avoid re-fetching when the user switches tabs and returns. Cache is not persisted across sessions. Cache eviction: LRU with max 100 entries. **[assumption]**

---

## 11. Capability Matrix Impact

**New capability key**: `'http.otelTraceCorrelation'` added to `CapabilityName` union in `src/lib/shared/capabilities.ts`.

**Entry**:

```typescript
'http.otelTraceCorrelation': {
  label: 'OTel trace correlation (traceparent injection + waterfall)',
  web: true,
  desktop: true,
  notes: 'Web: public trace backends only (CORS + Worker routing; private-network Tempo/Jaeger require desktop or self-host). Desktop: full support including private-network backends with DNS guard. SecretRef handles resolved in Electron main only.',
}
```

After editing `capabilities.ts`, run `npm run capabilities:matrix` to regenerate `docs/CAPABILITY_MATRIX.md` and commit both. CI will fail (`npm run capabilities:check`) if the matrix drifts from the source.

---

## 12. Acceptance Criteria and Test Plan

### AC-01: traceparent Format

- GIVEN: `spec.otel.inject = true` and `headers` does not contain `traceparent`
- WHEN: `executeHttpProxy` is called
- THEN: the outgoing request headers contain `traceparent` matching the regex `/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/`
- AND: `result.response.otelTraceId` is the 32-hex trace ID embedded in that header

**Test location**: `shared/protocol/__tests__/http-proxy.test.ts` (Vitest unit test; mock `Fetcher`)

### AC-02: User-Supplied traceparent Is Not Overwritten

- GIVEN: `spec.otel.inject = true` AND `spec.headers['traceparent'] = '00-aabbcc...-ff001122-01'`
- WHEN: `executeHttpProxy` is called
- THEN: the outgoing `traceparent` is unchanged (the user-supplied value)

**Test location**: same file as AC-01

### AC-03: Injection Off by Default

- GIVEN: `spec.otel` is absent
- WHEN: `executeHttpProxy` is called
- THEN: the outgoing request headers do NOT contain `traceparent`
- AND: `result.response.otelTraceId` is undefined

**Test location**: existing `http-proxy.test.ts` baseline tests should still pass (no regression)

### AC-04: Waterfall Transform — Tempo Fixture

- GIVEN: a fixture JSON file matching the Grafana Tempo `/api/traces/{traceId}` response shape (stored at `tests/fixtures/tempo-trace.json`)
- WHEN: `transformTraceToWaterfall(fixtureJson)` is called
- THEN: returns an array of `WaterfallSpan` objects where:
  - spans are sorted by `startTimeUnixNano` ascending
  - root span has `parentSpanId` null/undefined
  - `durationMs` is computed correctly from `endTimeUnixNano - startTimeUnixNano`
  - error spans have `status === 'ERROR'`

**Test location**: `src/features/http/lib/__tests__/otelTraceTransform.test.ts` (Vitest)

### AC-05: Waterfall Transform — Jaeger Fixture

- Same as AC-04 but with `tests/fixtures/jaeger-trace.json` fixture (Jaeger `/api/traces/{traceId}` response shape)

### AC-06: Trace Fetch Retry (Unit)

- GIVEN: a mock trace handler that returns 404 twice, then 200 with a valid trace on the third attempt
- WHEN: the trace fetch function is called
- THEN: it retries and returns the successful trace on the third attempt
- AND: the total call count is 3

**Test location**: Vitest unit test mocking the `Fetcher`

### AC-07: Trace Fetch — No Trace Found After Retries

- GIVEN: a mock trace handler that returns 404 three times
- WHEN: the trace fetch function is called with the configured retry policy
- THEN: it returns `{ found: false, reason: 'not_found' }` after 3 attempts
- AND: does not throw

**Test location**: same as AC-06

### AC-08: SSRF Guard — Trace Endpoint Validation

- GIVEN: a trace endpoint configured as `http://169.254.169.254/api/traces/...`
- WHEN: the trace fetch is invoked
- THEN: `validateURL` returns `{ valid: false }` and no network call is made

**Test location**: `tests/security/url-validation.test.ts` (extend existing suite)

### AC-09: E2E — Injection + Mock Trace Backend (Electron)

- GIVEN: an Electron e2e test that boots a mock HTTP server (per the pattern in `e2e-electron/`) returning a static trace JSON on `GET /api/traces/:id`
- WHEN: the user sends a request with OTel injection enabled, pointing to the mock backend
- THEN: the Trace tab appears in the response panel and renders at least one span bar

**Test location**: `e2e-electron/` new spec; gated by `@otel` tag so it only runs when explicitly requested in CI

### AC-10: Capability Matrix Regeneration

- `npm run capabilities:check` passes after `capabilities.ts` and `CAPABILITY_MATRIX.md` are both updated with the new `http.otelTraceCorrelation` entry.

---

## 13. Success Metrics

Because demand is unvalidated, the validation spike (phase 1, below) defines the minimum signal to justify a full build.

**Validation spike gates** (measured at 4 weeks post-flag-enabled for opted-in users):

- Metric 1: At least 20 distinct users enable OTel injection and configure a trace backend.
- Metric 2: Of users who see the Trace tab, ≥ 30% open it on at least 3 separate response entries (indicating intent to use, not just curiosity).
- Metric 3: No critical security bugs filed against the trace backend query path.

**Post-GA metrics (if spike passes)**:

- Weekly active users of the Trace tab (target: 15% of HTTP-active users within 3 months of GA).
- Trace found rate: percentage of injected requests where a trace is returned (target: ≥ 60% among users who have OTel-instrumented backends — a low rate is a signal that trace lag exceeds retry window or sampling misses are common).
- Trace fetch p99 latency: time from response-received to trace-rendered (target: ≤ 5 s at p99 — bounded by retry ceiling).
- Zero SSRF-related security reports attributed to the trace endpoint query path.

---

## 14. Rollout Phases

### Phase 0 — Validation Spike (2 weeks, 1 engineer)

**Goal**: Determine whether real users want this before committing to a full build.

Deliverables:

- A feature-flagged `traceparent` injection toggle in `RequestSettingsEditor.tsx` (no trace fetch, no Trace tab).
- A text field in the response panel showing the raw `traceparent` value that was sent (proof that injection works and is visible).
- A docs page or tooltip explaining how to use the trace ID in Tempo/Jaeger to find the trace manually.
- Opt-in beta flag gated by a `ENABLE_OTEL_BETA=true` environment variable or a settings toggle.
- Instrumentation of the toggle engagement rate (how many users enable it, how many requests they fire with it on).

Success gate: 20+ distinct users enable injection in 4 weeks. If the gate is not met, the feature is deprioritized.

### Phase 1 — Tempo Integration (3 weeks, 1-2 engineers)

**Goal**: Full injection + trace fetch + waterfall, Tempo only, Electron + self-host.

Deliverables:

- `shared/protocol/types.ts` and `http-proxy.ts` changes for injection.
- `otel-handler.ts` in `electron/main/handlers/` for trace fetch IPC.
- `/api/otel-trace` Hono route in `worker/app.ts` for self-host.
- `OtelConfig` in environment data model.
- `TraceTab.tsx` and `otelTraceTransform.ts` for the waterfall UI.
- Unit tests (AC-01 through AC-08).
- Capability matrix updated.

### Phase 2 — Jaeger Support (1 week)

**Goal**: Add Jaeger as a backend option (different JSON shape for the trace response; same transport, same SSRF path).

Deliverables:

- Jaeger response shape in `otelTraceTransform.ts`.
- Fixture and unit tests (AC-05).
- UI: add 'Jaeger' to `backendKind` select.

### Phase 3 — Web / Cloudflare Worker Path (2 weeks)

**Goal**: Enable the Worker path for Grafana Cloud Tempo (public endpoint).

Deliverables:

- Auth-gated `/api/otel-trace` Worker route (behind `WORKER_PROXY_TOKEN` gate, same as `/api/proxy`).
- Validate that Grafana Cloud Tempo HTTP query API is reachable from Cloudflare Worker.
- Documentation for the web path limitation (private backends blocked).

### Phase 4 — Post-v1 (future)

- `tracestate` header injection.
- OTLP/gRPC query protocol support.
- Collection runner integration (attach trace IDs to run reports).
- Datadog / Honeycomb / AWS X-Ray adapters.
- Span attribute display redaction toggle (user chooses which attribute keys are masked).

---

## 15. Risks and Open Questions

### Risk 1 — Unproven Demand (HIGH probability, HIGH impact)

The feature may have narrow appeal (only OTel-instrumented teams, who already have good tooling in Tempo/Jaeger UI). If the validation spike doesn't hit the gate, we have sunk 2 weeks (Phase 0) rather than 10+ weeks. This is the correct risk management path — keep Phase 0 minimal.

### Risk 2 — Trace Lag Exceeds Retry Window (MEDIUM probability, MEDIUM impact)

In high-cardinality trace pipelines with aggressive batching (e.g., 30 s flush intervals in the OTel Collector), the trace may not be indexed within the 7 s retry window. The Trace tab would show "not found" despite the trace existing. Mitigation: expose a "Re-fetch" button in the Trace tab; consider making the retry ceiling user-configurable in Phase 1b.

### Risk 3 — Sampling Drops the Request (MEDIUM probability, HIGH UX impact)

The service's sampler may drop this specific request (head-based sampling at 10%). The trace simply does not exist. We always inject with flags=`01` (sampled=true) per the W3C spec, which signals downstream services to sample this trace. However, if the head sampler at the entry point overrides this, the trace won't exist. We cannot force a service's sampler. The "not found" state must clearly explain this scenario to avoid user confusion.

### Risk 4 — Trace Backend Auth Variety (MEDIUM probability, MEDIUM effort)

Tempo and Jaeger auth comes in many forms: Bearer token (most common), Basic auth, mTLS, OIDC. v1 supports Bearer only. Teams using mTLS-protected Tempo (enterprise) will find it blocked until Phase 4. We must clearly document this limitation in v1.

### Risk 5 — Large Traces Degrade Renderer Performance (LOW probability, HIGH impact)

A microservice trace with hundreds of spans and thousands of attribute key-value pairs is a large JSON payload. Rendering 1,000+ spans as DOM elements will cause jank. Mitigation: cap at 200 spans rendered (FR-05), virtualize the span list if needed (react-virtual or similar), and ensure `transformTraceToWaterfall` is called off the critical render path.

### Open Question 1

Should `traceparent` injection be on by default when an `OtelConfig` is present in the active environment, or always opt-in at the request level? Current proposal: environment-level default (if `OtelConfig.enabled = true`, all requests in that environment inject). This could surprise users who don't know their environment has OTel enabled. Alternative: always per-request opt-in with an "Enable for all requests in this environment" convenience toggle. **Needs product decision before Phase 1 implementation.**

### Open Question 2

Should the trace waterfall include client-side spans (e.g., if the downstream service propagates `traceparent` and creates a child span from the Restura-injected trace ID)? The current design assumes the Restura-injected span is the root. If an upstream gateway creates a parent span before the service Restura talks to, Restura's injected ID may not be the root of the full trace. **[assumption]** Defer to Phase 2: v1 fetches by the exact trace ID Restura generated.

### Open Question 3

When the self-host path stores an inline auth token in the environment config, is it encrypted at rest? The web self-host uses `SecretValue { kind: 'inline' }`, which lives in the environment JSON on disk (or in the encrypted Electron store on desktop). For the Node/Docker self-host, the JSON is only as secure as the filesystem. This is the same caveat that applies to all other inline secrets in that deployment model. No new risk, but worth documenting in the self-host docs.

---

## 16. Round-2 Review Addendum (verified findings)

Round-1 claims re-verified (`NormalizedResponse` real, injection site sound, `REQUEST_DENY` doesn't block `traceparent`). Deeper findings:

| #    | Tag         | Sev  | Finding                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                         |
| ---- | ----------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | SECURITY    | High | **FIXED INLINE (§8.3):** `assertUrlHostnameSafe` hard-codes `allowPrivateIPs:false` (`dns-guard.ts:60`), so reusing it would block every private Tempo/Jaeger — contradicting the desktop "full support" claim.                                             | Add a dedicated `assertOtelBackendSafe(url,{allowPrivateIPs})` mirroring `kafka-broker-guard.ts`/`mqtt-broker-guard.ts`; thread `allowPrivateIPs` from the env OTel config. |
| R2-2 | FEASIBILITY | Med  | Trace-fetch happens after the response is already shown; the retry/poll (1/2/4 s) location, the bounded "no trace found" UX, and the history "re-fetch" button are under-specified. The IPC payload that carries `OtelConfig` to the handler isn't defined. | Define an `OtelTraceFetchRequest` IPC/route schema carrying the resolved `OtelConfig`; specify bounded retry + "not found" + history re-fetch in §6/§10/§12.                |
| R2-3 | PARITY      | Low  | §11 frames web as "public Tempo only" as if a choice; really the CF Worker physically cannot reach private networks (it runs in Cloudflare's infra).                                                                                                        | Reword to: private backends are unreachable from the Worker by infrastructure, not policy; web = public Grafana Cloud Tempo only.                                           |
| R2-4 | CONSISTENCY | Low  | Phase-0 spike (§14) shows the raw `traceparent` in the response panel but excludes backend fetch/waterfall — could read as if Phase 0 includes the full feature.                                                                                            | State explicitly: Phase 0 = injection + read-only trace-id display for manual lookup; no backend fetch.                                                                     |
| R2-5 | SECURITY    | Low  | §9.3 relies on `scrubEvent` to keep trace payloads out of Sentry, but doesn't verify it covers OTel span attributes (which may carry SQL/URLs/tokens).                                                                                                      | Confirm/extend `scrubEvent` coverage before Phase 1; never log raw traces.                                                                                                  |
