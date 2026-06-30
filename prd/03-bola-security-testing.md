# PRD 03 — In-Client Lightweight API Security Testing

## BOLA Replay, Auth-Strip, and Passive Response Hygiene

**Status:** Draft  
**Author:** Product  
**Date:** 2026-06-30  
**Version:** 0.1

---

## 1. Summary

Add a lightweight, shift-left API security testing surface directly inside Restura. The initial scope covers three checks that are uniquely cheap when you own the request, the multi-environment auth profiles, and the response:

1. **BOLA replay** (OWASP API Security #1): execute a request as identity A, replay it under identity B's credentials, and flag if A's resource is returned (HTTP 2xx + matched object identity) where a 403/404 was expected.
2. **Auth-strip check**: resend the same request with all credentials removed; a 2xx reply signals a missing authentication gate entirely (a prerequisite check that must pass before a BOLA conclusion is drawn).
3. **Passive response hygiene**: on every HTTP response Restura already receives, run a non-blocking, read-only scan for sensitive-data patterns in the body and missing security headers (HSTS, CSP, X-Content-Type-Options, X-Frame-Options).

OpenAPI-driven negative fuzzing (boundary/type violations on request parameters drawn from an attached spec) is scoped to Phase 2. It reuses the existing `src/features/contracts/` parsing pipeline and is described in Phase sections below.

No new request transport is introduced. All replays pass through the existing `executeRequest()` pipeline in `src/features/http/lib/requestExecutor.ts`, inheriting SSRF validation, header policy, and SecretRef resolution for free.

---

## 2. Problem and Evidence

### The gap OWASP is naming

The OWASP API Security Top 10 (2023 edition, owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/) ranks **Broken Object Level Authorization (BOLA) as the #1 API vulnerability category**, reflecting broad industry evidence across API-breach post-mortems. The specification describes it as occurring when an API endpoint fails to verify that the requesting user has permission to access a specific object, allowing an attacker to substitute another user's object identifier in the same request.

A widely-cited industry approximation suggests BOLA-class flaws account for roughly 40% of API attack surface. The exact figure depends on measurement methodology and the population of APIs studied; this document treats it as directionally accurate rather than a precise statistic.

**Auth-strip failures** (authentication entirely absent or bypassable) appear in OWASP API Security #2 (Broken Authentication) and are a prerequisite category to confirm before calling a cross-identity data leak a true BOLA.

### The competitive field is not solving in-client authorization testing

The OSS tooling landscape divides cleanly into two camps that leave a gap:

- **Schema/input fuzzers (Schemathesis, Dredd, RESTler)**: these test whether the API correctly rejects invalid inputs per its schema. Schemathesis (github.com/schemathesis/schemathesis) is the best-in-class representative and explicitly does not test authorization — its README scopes itself to "checking if your API conforms to its schema."
- **Full DAST scanners (OWASP ZAP, StackHawk, 42Crunch)**: these perform comprehensive attack-surface testing but are separate tools with separate setup, credentials, and pipeline integration. They are not integrated into the development workflow at the moment of writing the request.

Lightweight clients (Bruno, Hoppscotch, Insomnia free tier, Thunder Client) ship essentially no security testing capability. Akto (akto.io), which occupied the in-client/CI security-testing niche for API tools, pivoted in 2025 toward AI and MCP security rather than per-endpoint BOLA replay.

### The in-client advantage

An API client in active use already holds:

- The fully-formed request with headers, body, and params
- Multiple environment definitions with real or test credentials for different identities
- The actual upstream response, delivered through an already-SSRF-guarded transport

This means a BOLA check costs one additional HTTP round trip (identity B replay) with zero new infrastructure. The marginal effort for the developer is far lower than switching to an external scanner. This PRD argues that advantage makes lightweight BOLA a natural fit for Restura.

**Important caveat:** In-client demand for this category of check is **inferred**, not empirically validated. No user research data is currently available showing that Restura's existing users want or would use built-in BOLA testing. The problem and competitive evidence are real; the product-market fit hypothesis requires validation. This risk is explicitly called out in Section 15.

---

## 3. Goals and Non-Goals

### Goals

- **G1**: Allow a developer to run a per-request BOLA check (A/B replay) in one click, using two environments or auth configurations they already have in Restura.
- **G2**: Provide an auth-strip check as the pre-condition test before a BOLA result is surfaced.
- **G3**: Surface passive response hygiene warnings on every HTTP response without any user action required — a zero-friction baseline.
- **G4**: Produce findings with enough detail (status codes, object comparison diff, missing headers) for a developer to act without switching tools.
- **G5**: Introduce no new outbound transport or SSRF surface; all traffic goes through the existing `executeRequest()` path.
- **G6**: Match the feature to web, self-host, and desktop parity where technically possible (see §11).

### Non-Goals

- **NG1**: This is not a replacement for ZAP, StackHawk, 42Crunch, or any comprehensive DAST scanner. It is a shift-left prompt, not a security audit.
- **NG2**: No automated vulnerability remediation, CVE scoring, or compliance reporting.
- **NG3**: No scanning of endpoints not already present in the user's collections or open tabs — no crawler, no discovery.
- **NG4**: No traffic interception, proxy mode, or man-in-the-middle capability.
- **NG5**: No detection-evasion features (rate-limit bypass, header randomization, user-agent spoofing for stealth). This tool is honest about what it is doing.
- **NG6**: No automated exploit generation or payload delivery beyond structured fuzzing derived from the attached OpenAPI spec.
- **NG7**: Phase 1 excludes OpenAPI-driven negative fuzzing (scoped to Phase 2).

---

## 4. Target Users and Top Use Cases

### Primary users

| Persona                   | Context                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Backend developer         | Writes a new REST endpoint, wants a quick sanity check that `GET /orders/{id}` cannot be accessed cross-user before merging |
| QA engineer               | Running a collection for a release smoke-test; wants authorization coverage alongside functional checks                     |
| Security-minded developer | Works at a company without a dedicated security team; uses Restura daily, needs lightweight shift-left tooling              |

### Top use cases (ranked by expected frequency)

1. **Per-request BOLA check during active development**: developer opens a request for `GET /users/{id}/profile`, selects "User A" and "User B" environments, clicks "Security check," sees whether B can read A's profile.
2. **Passive hygiene review**: developer notices missing HSTS warning in the response panel on a newly deployed staging endpoint and fixes the header before production.
3. **Collection-level authorization sweep**: QA selects a collection folder containing all account endpoints and runs a security scan with two identity environments; gets a findings report at the end.
4. **Auth-strip sanity check**: developer verifies that a new endpoint returns 401/403 when the `Authorization` header is removed, as a quick regression guard.

---

## 5. User Stories

- As a backend developer, I want to replay a request I already have open under a different user's token so that I can verify my new endpoint enforces object-level authorization without leaving Restura.
- As a developer, I want to re-send a request with all credentials stripped and see whether the API returns a 401 or 403 so that I can confirm the endpoint is authentication-gated before drawing authorization conclusions.
- As a developer receiving any HTTP response, I want to see a passive hygiene summary (missing security headers, obvious sensitive fields in the body) so that I have a zero-effort baseline check on every call I make.
- As a QA engineer, I want to run an authorization sweep over an entire collection folder using two identity environments so that I get a consolidated findings report before a release.
- As a developer working with an OpenAPI spec attached to my collection, I want the security runner to generate boundary-violating requests from the spec and verify the API rejects them correctly so that I can catch input-validation regressions (Phase 2).

---

## 6. Functional Requirements

### 6.1 Identity selection — how A and B are resolved

**Identity A** is the user's currently-active environment at the time the security check is launched. Its resolved variable set (from `useEnvironmentStore.getState().getActiveEnvironment()`) forms the baseline `envVars` for identity A.

**Identity B** is a second environment selected explicitly by the user in the security check configuration panel. Its variable set is read from `useEnvironmentStore.getState().environments`, filtered to the user's chosen environment ID.

Both identities also carry a request-level `auth` descriptor from `HttpRequest.auth`. The security harness allows the user to optionally override the auth descriptor per-identity (B may use a completely different auth type), but the simpler default is: both identities share the same request structure with the same `auth.type`, varying only the token/credential value supplied via environment variables.

**[assumption]** Restura has no "auth profile" abstraction separate from environments. This feature maps multi-identity testing entirely onto the existing `Environment` primitive (`src/types/collection.ts:Environment`, field `variables: KeyValue[]`). No new stored type is required in Phase 1.

Sign-at-wire auth types (`aws-signature`, `oauth1`, `wsse`, `digest`, `ntlm`) can be used for identity A (the original request); using them for identity B replay requires those credentials to also be resolvable as environment variables and passed through `spec.auth`. This is supported by the existing pipeline but requires the user to have configured it.

### 6.2 BOLA check — definition of positive and negative

**Pre-condition**: The auth-strip check (§6.3) MUST be run before a BOLA finding is emitted. If the auth-strip returns 2xx (i.e., the endpoint has no authentication gate), the finding is classified as "Broken Authentication / Missing Auth Gate" (OWASP API2), not BOLA.

**BOLA positive** (flag as finding):

- Identity B's replay returns HTTP 2xx
- AND the response body contains object content that, by structural comparison, matches identity A's object

**BOLA negative** (pass):

- Identity B's replay returns 403, 404, or any 4xx/5xx
- OR identity B's response body is structurally empty / differs from A's in identity-bearing fields

**Object identity comparison**: byte-exact body comparison is not used — it generates false positives (timestamps, request IDs, ETag, pagination cursors vary legitimately). Instead:

- For JSON responses: the user nominates **identity fields as dot/bracket JSON paths** (e.g. `id`, `data.user.id`, `items[0].ownerId`), resolved with lodash's `get` (already a dependency) **[RESOLVED — user-specified JSON paths]**. Each path is read from both responses and compared with exact-match (strict equality after JSON-normalizing). This handles nested objects and indexed array elements, avoiding the silent false-negatives a top-level-key-only compare would produce on nested payloads. Rules: a path resolving to `undefined`/missing in **both** responses = not an identity match (no finding); resolving in A but `undefined` in B (or vice-versa) = not a match; `null` is compared as a concrete value. For collection/array responses where no element-level path is given, fall back to status-code-only (low confidence). Phase 1 = manual path entry; Phase 2 may auto-suggest paths from the OpenAPI response schema.
- When no identity fields are configured: fall back to status-code only (2xx = possible BOLA, flag with low confidence; 4xx = pass).

**False-positive controls**:

- Cookie-jar isolation: both A and B replays run with `disableCookieJar: true` (a flag already present on `RequestSettings`, mirrored through `effectiveSettings` in requestExecutor.ts:199). This prevents A's `Set-Cookie` session from leaking into B's replay. Without this, B would silently inherit A's session and every check would false-negative. This MUST be enforced at the harness level, not left to user configuration.
- Public resource detection: if the original request has `auth.type === 'none'`, skip BOLA and surface an informational note: "This request has no auth configured — BOLA check is not meaningful."
- User-configured suppression: findings can be marked "acknowledged/false-positive" per request, persisted in the security findings store (§10).

### 6.3 Auth-strip check

The auth-strip replay sends the same request with:

- `spec.auth` omitted (or `auth.type: 'none'`)
- Authorization, X-API-Key, and any other auth-derived headers removed
- Environment variables resolved from identity A

**Expected outcome**: HTTP 401 or 403.

**Pass**: 401 or 403 response.  
**Fail / finding**: Any 2xx, 3xx, or non-standard response — surfaces as "Missing Authentication Gate" finding, severity High.

The auth-strip check runs independently of BOLA. It can be triggered without a B-identity configured (it requires only the original request). At the collection-level runner, auth-strip runs for every request in the scope, even those not selected for BOLA.

### 6.4 Passive response hygiene — rule catalog

Passive checks run against every `ApiResponse` the app already has in memory. They are non-blocking, read-only, and require no additional network calls.

**Security header rules** (applied to `response.headers`):

| Rule ID | Header checked                   | Condition for finding                                                    | Severity |
| ------- | -------------------------------- | ------------------------------------------------------------------------ | -------- |
| H01     | `Strict-Transport-Security`      | Absent on HTTPS response                                                 | Medium   |
| H02     | `Content-Security-Policy`        | Absent                                                                   | Medium   |
| H03     | `X-Content-Type-Options`         | Absent or not `nosniff`                                                  | Low      |
| H04     | `X-Frame-Options`                | Absent (relevant for HTML responses)                                     | Low      |
| H05     | `Cache-Control`                  | Absent or permissive (`no cache directives`) on responses with auth data | Low      |
| H06     | `Referrer-Policy`                | Absent                                                                   | Info     |
| H07     | `Set-Cookie`                     | Cookie missing `Secure` or `HttpOnly` attribute                          | Medium   |
| H08     | `Access-Control-Allow-Origin: *` | Wildcard origin on response to authenticated request                     | High     |

**Sensitive data rules** (applied to `response.body` string, JSON-parsed where possible):

| Rule ID | Pattern / key                  | Condition                                                                                       | Severity |
| ------- | ------------------------------ | ----------------------------------------------------------------------------------------------- | -------- |
| D01     | Credit card pattern            | Luhn-valid 13–19 digit sequence matching major card IsoFormats                                  | High     |
| D02     | Common password field names    | JSON key `password`, `passwd`, `secret`, `token`, `apiKey` with non-null value in response body | High     |
| D03     | Private key header             | `-----BEGIN RSA PRIVATE KEY-----` or similar PEM header                                         | Critical |
| D04     | AWS credential pattern         | `AKIA[0-9A-Z]{16}`                                                                              | Critical |
| D05     | Email address in response body | Valid RFC 5322 email when endpoint path suggests non-user-profile resource                      | Info     |
| D06     | Social security number (US)    | `\d{3}-\d{2}-\d{4}` or `\d{9}`                                                                  | High     |
| D07     | JWT in response body           | `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`                                             | Medium   |

Rules are implemented as pure functions over `ApiResponse`. The catalog is versioned and extensible — rules are declared in a static array; no network or AI call is needed. False-positive risk on passive checks is acknowledged; severity levels are set conservatively. Users can suppress specific rule IDs per-endpoint.

**[assumption]** The header policy checker does not attempt to re-implement the `shared/protocol/header-policy.ts` hop-by-hop logic; it runs on the received response headers as they appear in `ApiResponse.headers`. It is the caller's responsibility to verify that the Cloudflare Worker and Electron HTTP handler forward security-relevant response headers verbatim without normalization before marking passive header checks as cross-harness reliable (see §8.4).

### 6.5 OpenAPI-driven negative fuzzing (Phase 2)

Deferred to Phase 2. Described here for planning completeness.

The negative fuzzer reads an OpenAPI spec attached to a collection via `ContractSpecSource` (already in `src/types/collection.ts`) using the existing `loadContractSpec` pipeline (`src/features/contracts/lib/specLoader.ts`). For each operation matching a selected request, it generates:

- Boundary-violating inputs: integers outside declared `minimum`/`maximum`, strings exceeding `maxLength`, missing `required` fields, wrong type values.
- Schema-invalid enumeration: values not in declared `enum` arrays.
- Extra-field injection: additional properties when `additionalProperties: false` is declared.

The base URL for generated requests MUST be sourced from the user's active environment (a variable such as `{{baseUrl}}`), not from the spec's `servers[]` block. Spec-provided server URLs are untrusted — they could point to external hosts. Failing to enforce this would introduce an SSRF vector. **[assumption]**

Generated requests pass through `executeRequest()` unchanged; the fuzz runner expects 4xx responses (typically 400 or 422) and flags 2xx or 5xx as findings.

### 6.6 Findings scoring and triage

| Severity | Examples                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Critical | PEM private key in response, AWS credential exposure                                                   |
| High     | BOLA confirmed (2xx + matched identity fields), Missing auth gate, wildcard CORS on auth'd endpoint    |
| Medium   | Missing HSTS/CSP, BOLA possible (2xx + no identity fields configured, low confidence), insecure cookie |
| Low      | Missing X-Content-Type-Options, X-Frame-Options, permissive Cache-Control                              |
| Info     | Missing Referrer-Policy, email pattern in non-profile response                                         |

Each finding carries: rule ID, severity, description, affected request name + URL, the specific header or body fragment triggering the finding (redacted per §10 before persistence), and a timestamp.

---

## 7. UX and Flows

### 7.1 Entry points

**Per-request "Security" action**: In the request response panel, alongside existing "Tests" and "Scripts" tabs, add a "Security" tab. It surfaces:

- Passive hygiene findings from the last response (automatically populated).
- A "Run BOLA check" action with an identity-B environment picker.
- A "Run auth-strip" action (single click, no extra config needed).

**Collection-level security scan**: In the collection context menu / CollectionRunnerDialog, add a "Security Scan" mode alongside "Run". When selected, the user configures:

- Scope: collection or folder.
- Identity B environment (required for BOLA checks; optional for auth-strip-only run).
- Which check types to run (BOLA, auth-strip, passive; checkboxes, all default on).

### 7.2 Findings panel

A dedicated "Security" panel (similar in position to the existing "Runs" panel in `src/components/shared/RunsPanel.tsx`) shows persisted findings history. Findings group by severity with expand/collapse. Each finding links back to the originating request.

### 7.3 ASCII wireframe — findings report

```
+---------------------------------------------------------------+
| SECURITY FINDINGS  [Collection: Payments API]  2026-06-30     |
| Run: 12 requests checked · 3 findings · 1 skipped            |
+---------------------------------------------------------------+
| [CRITICAL] D03  PEM Private Key in Response Body              |
|   POST /debug/keys  ·  192ms                                  |
|   Fragment: "-----BEGIN RSA PRIVATE KEY-----..." (truncated)  |
|   [ Acknowledge ]  [ Jump to request ]                        |
+---------------------------------------------------------------+
| [HIGH]     BOLA  Cross-identity data leak                     |
|   GET /users/{id}/profile  · Identity B: "Tester-B" env      |
|   A's status: 200 · B's status: 200                          |
|   Matched fields: id=1042, email=alice@example.com            |
|   Expected: 403 or 404                                        |
|   [ Acknowledge ]  [ Jump to request ]                        |
+---------------------------------------------------------------+
| [MEDIUM]   H01  Missing Strict-Transport-Security             |
|   GET /orders  ·  HTTPS endpoint, header absent              |
|   [ Suppress rule for this endpoint ]  [ Jump to request ]   |
+---------------------------------------------------------------+
| [SKIPPED]  GET /public/status  — auth.type=none, BOLA N/A   |
+---------------------------------------------------------------+
| Auth-strip results: 11/11 requests returned 401 or 403  [OK] |
+---------------------------------------------------------------+
```

### 7.4 Identity picker component

A small inline form in the Security tab:

```
Run BOLA Check
  Identity A: [Active Environment: "Dev-Alice"]  (read-only)
  Identity B: [  Select environment...  v]       (required)
  Identity fields (optional): [id, userId, email]
  [ Run BOLA Check ]
```

If no second environment exists, the picker shows "Create a second environment to test cross-identity authorization."

---

## 8. Architecture and Implementation

### 8.1 Replay harness — the single execution path

The core architectural constraint is: **no parallel execution path.** All replays call the existing `executeRequest()` function (requestExecutor.ts:347). A replay is constructed by preparing a modified `RequestExecutorOptions` object (lines 56–61) and calling `executeRequest()` again:

```
// Identity A — already executed normally by the user
const resultA = await executeRequest({
  request: originalRequest,
  envVars: envA,   // from identity A environment
  globalSettings,
  resolveVariables,
});

// Identity B replay — same function, swapped envVars and/or auth
const requestForB = { ...originalRequest, auth: identityBAuth };
const resultB = await executeRequest({
  request: { ...requestForB, settings: { ...requestForB.settings, disableCookieJar: true } },
  envVars: envB,   // from identity B environment
  globalSettings,
  resolveVariables,
});

// Auth-strip replay
const requestStripped = { ...originalRequest, auth: { type: 'none' } };
const resultStripped = await executeRequest({
  request: { ...requestStripped, settings: { ...requestStripped.settings, disableCookieJar: true } },
  envVars: envA,
  globalSettings,
  resolveVariables,
});
```

Critical: `disableCookieJar: true` MUST be injected for both B and auth-strip replays. The `disableCookieJar` flag is respected in `buildProxyRequestSpec` (requestExecutor.ts:204–210) and prevents `persistResponseCookies` (line 404) from writing A's session cookies into the shared `useCookieStore`, which would cause B's replay to silently inherit A's authenticated session and false-negative on every BOLA check.

**Pre-request and test scripts**: Replay executions MUST skip pre-request and test scripts (`request.preRequestScript` and `request.testScript` should be cleared or the replay option should gate on them). Pre-request scripts may mutate environment state or make side-effect network calls not appropriate in a security scan context.

The SSRF guard (`validateURL` at requestExecutor.ts:163–169, backed by `shared/protocol/url-validation.ts:validateURL`) runs inside `buildProxyRequestSpec` for every replay call. The security feature adds **zero new attack surface** on the outbound side. Replays can only reach hosts already reachable by the original request.

### 8.2 Auth credential resolution

`buildProxyRequestSpec` (requestExecutor.ts:148) resolves auth in two stages:

1. **Bearer / Basic / API-key / OAuth2**: `applyAuthHeaders` (src/features/auth/lib/applyAuthHeaders.ts:28) → `buildAuthCredential` (src/features/auth/lib/buildAuthCredential.ts:53). For inline and env-variable-based tokens, resolution is synchronous in the renderer.

2. **Sign-at-wire types (SigV4, OAuth1, WSSE, NTLM)**: passed through `spec.auth` to the proxy layer (`shared/protocol/auth-signer.ts`), signed against exact wire bytes. Identity B with these auth types requires the B-identity credentials to be provided via environment variables that the spec's auth descriptor references.

**Handle-based tokens (SecretRef, ADR-0007)**: `buildAuthCredential` returns `requiresMainSideApply: true` when any sensitive field is a `{ kind: 'handle'; id }` reference. `assertHandleSupported` (applyAuthHeaders.ts:56–62) throws on the web harness if this flag is set. Therefore:

- BOLA replay with handle-based identity tokens requires the **Electron desktop app**.
- On web, both identities must use inline secrets or environment variable strings.
- This is a capability matrix implication (see §11).

### 8.3 Environment variable resolution for identity B

Environment B's variable set is read directly from `useEnvironmentStore.getState().environments` by selecting the environment chosen as identity B. The resolution call `resolveVariables(text)` in `RequestExecutorOptions` is replaced by a version scoped to environment B's variable set, using the same `escapeRegExp`-guarded replacement logic (useEnvironmentStore.ts:92–109). No new resolution primitive is needed.

### 8.4 Passive checks — cross-harness considerations

Passive checks run as pure functions over `ApiResponse` (src/types/http.ts:72–92) in the renderer. They are harness-agnostic by construction — `ApiResponse` is populated identically by the Cloudflare Worker path (`executeProxiedRequest` → ProxyJsonResponse), the Node/Docker path (same Hono app), and the Electron path.

**Verification required before shipping**: confirm that security-relevant response headers (`Strict-Transport-Security`, `Content-Security-Policy`, `Set-Cookie`, `Access-Control-Allow-Origin`) are forwarded verbatim in the `ProxyJsonResponse.headers` map by both the Worker (`worker/handlers/`) and the Electron HTTP handler (`electron/main/handlers/http-handler.ts`). If either normalizes or strips these headers, passive header checks will produce incorrect results. This is a test requirement in §12.

### 8.5 OpenAPI fuzz pipeline (Phase 2)

Phase 2 fuzz requests are generated by a new module `src/features/security/lib/negativeRequestGenerator.ts` that consumes `OperationMatch` output from `src/features/contracts/lib/operationMatcher.ts`. It generates `HttpRequest[]` with schema-violating parameters. Each generated request is passed to `executeRequest()` via the same path as the BOLA/strip replays. The base URL comes from the user's environment `{{baseUrl}}` variable (or whatever base variable is configured), never from `spec.servers[]`.

### 8.6 New feature module location

```
src/features/security/
  lib/
    bolaRunner.ts           -- orchestrates A/B replay + auth-strip
    passiveHygiene.ts       -- pure functions: runHeaderChecks(response), runBodyChecks(response)
    findingsStore.ts        -- Zustand store backed by new Dexie table `securityFindings`
    negativeRequestGenerator.ts  -- Phase 2: generate boundary-violating requests from OperationMatch
  components/
    SecurityTab.tsx         -- per-request Security tab in response panel
    SecurityFindingsPanel.tsx -- sidebar panel (mirrors RunsPanel pattern)
    IdentityPicker.tsx      -- A/B environment selector
  hooks/
    useSecurityRun.ts       -- collection-scope scan orchestration
```

### 8.7 Collection-runner integration

The collection-level security scan is a new mode in the existing `CollectionRunnerDialog` (src/features/collections/components/CollectionRunnerDialog.tsx). It calls `bolaRunner.runCollection()` which iterates `RunnableRequest[]` (same structure as `flattenRunnables.ts` already produces) and calls `executeRequest()` per-request, per-identity. Results are written to `findingsStore`.

---

## 9. Security Considerations

This section is marked CRITICAL. This feature deliberately sends attacker-style traffic to APIs the user has configured. That creates responsibilities.

### 9.1 SSRF guard is inherited, not bypassed

Every replay call flows through `buildProxyRequestSpec` → `validateURL` (requestExecutor.ts:163–169). The SSRF guard in `shared/protocol/url-validation.ts` blocks RFC 1918, CGNAT, link-local, cloud-metadata endpoints (169.254.169.254 in any encoding), IPv6 ULA, and IPv4-mapped-IPv6 private addresses. The security feature introduces no call to `fetch`, `net.connect`, or any other network primitive directly. This is the strongest security property of the "no parallel path" architecture.

The DNS pre-flight guard in `electron/main/security/dns-guard.ts` (`assertHostnameSafe`) also runs on the Electron path for every `executeRequest()` call. BOLA replays and auth-strip checks benefit from this without any additional wiring.

### 9.2 Only user-entered hosts

The feature MUST NOT probe hosts not already in the user's request. For Phase 2 OpenAPI fuzzing, the base URL MUST come from the user's environment variables, not from spec-provided `servers[]`. Engineering MUST enforce this at generation time; the code review checklist for Phase 2 MUST include a verification that `servers[]` is never used as a URL source.

### 9.3 Secrets via SecretRef

The B-identity auth descriptor follows the same `SecretValue` = `string | SecretRef` pipeline as any other request. Handle-based tokens (`{ kind: 'handle' }`) are resolved only in the Electron main process by `secret-handle-store.ts`. The renderer never sees plaintext handle values. The security harness does not implement any special credential path; it reuses the existing `applyAuthHeaders` / `buildAuthCredential` chain.

### 9.4 Response data is not exfiltrated

Responses from BOLA replays are held transiently in memory for comparison and then discarded. Only the finding metadata (matched field names, truncated fragment, status codes) is written to the `securityFindings` Dexie table. Full response bodies are NEVER persisted. The persistence model mirrors `useCollectionRunStore`'s explicit constraint (useCollectionRunStore.ts:6–12: "results carry statuses, timings, and assertion outcomes — never response bodies"). Any finding snippet stored must pass through `collection-export-redactor.ts` (electron/main/security/collection-export-redactor.ts) before export.

### 9.5 Ethical use framing

The product MUST surface a clear notice in the security feature UI:

> "Security checks send additional requests to the target API using the credentials you have configured. Only run security checks against APIs you have permission to test. Restura does not provide or endorse any credential bypass or evasion capability."

This notice appears once per session, acknowledged by the user before their first security scan. It is not a legal disclaimer; it is a prompt to think before running against production.

### 9.6 No detection-evasion

The security feature MUST NOT implement:

- Header randomization intended to bypass WAF detection
- Rate-limit evasion delays or jitter designed to avoid detection
- User-agent spoofing for stealth
- Any multi-step bypass sequence (e.g., token rotation to avoid replay detection)

This is consistent with Non-Goal NG5. If a WAF or rate-limiter blocks the replay, the check is recorded as "inconclusive — blocked by rate-limit or WAF" and not as a false-negative pass.

### 9.7 No credential logging

The security harness must ensure that B-identity credential values (tokens, passwords) are not written to any log, Sentry error event, or the Dexie persistence layer. The existing `scrubEvent` in `electron/main/lifecycle/sentry.ts` already drops `request` objects from Sentry events; the security harness must not introduce a new path that bypasses this.

---

## 10. Data Model and Persistence

### 10.1 New Dexie table: `securityFindings`

Add version bump to `src/lib/shared/dexie-storage.ts` (currently at version 13 per CLAUDE.md for `arenaRuns`). New table at version 14:

```typescript
// New Dexie table schema (version 14)
interface SecurityFinding {
  id: string; // uuidv4
  ruleId: string; // e.g., "BOLA", "H01", "D03"
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  requestId: string; // links to the originating request
  requestName: string;
  requestUrl: string; // scheme+host+path only; query params stripped if they contain tokens
  checkType: 'bola' | 'auth-strip' | 'passive-header' | 'passive-body' | 'fuzz';
  status: 'open' | 'acknowledged' | 'false-positive';
  // BOLA-specific
  identityAStatus?: number;
  identityBStatus?: number;
  matchedFields?: string[]; // field names only, never values
  // Passive/header-specific
  headerName?: string;
  // Body-specific — truncated fragment, redacted
  bodyFragment?: string; // max 200 chars, runs through redactor
  timestamp: number;
  scanRunId: string; // groups findings from one run
  acknowledgedAt?: number;
  acknowledgedNote?: string;
}
```

**MAX_FINDINGS per scan run**: 200 (follows `MAX_RUNS` precedent in `useCollectionRunStore`). Oldest findings are dropped when the cap is reached.

**Body fragment redaction**: The `bodyFragment` field captures at most 200 characters surrounding the detected pattern. Before storage and before export, it MUST be run through the pattern from `collection-export-redactor.ts` to strip any embedded secrets. Patterns that match credential-like strings (same ruleset as D01–D07 above) are replaced with `[REDACTED]` in the stored fragment.

### 10.2 No response body persistence

Response bodies from A, B, and auth-strip replays are held in memory only during comparison. They are released after the comparison function returns. The comparison function receives `ApiResponse` objects by value; the caller zeroes the `body` field of both responses before returning findings to the store.

### 10.3 Findings export

Findings can be exported as JSON or as a markdown summary from the Findings panel. Export uses the same redaction path as collection export. Exported findings never include the full response body.

---

## 11. Capability Matrix Impact

New capabilities to add to `src/lib/shared/capabilities.ts`:

```typescript
'security.bola':            { label: 'BOLA cross-identity replay',         web: true,  desktop: true,
  notes: 'Handle-based identity tokens require desktop; inline/env tokens work on web' }
'security.authStrip':       { label: 'Auth-strip check',                   web: true,  desktop: true }
'security.passiveHygiene':  { label: 'Passive response hygiene checks',    web: true,  desktop: true }
'security.openApiFuzz':     { label: 'OpenAPI negative fuzzing (Phase 2)', web: true,  desktop: true }
```

After adding these, run `npm run capabilities:matrix` to regenerate `docs/CAPABILITY_MATRIX.md` and `npm run capabilities:check` to verify no drift.

**Note on handle-based tokens**: `security.bola` is listed as `web: true` for the common case (inline env tokens). A sub-capability for handle-based identity tokens is desktop-only, but this is a credential-resolution limitation, not a BOLA-check limitation. The notes field conveys this distinction.

---

## 12. Acceptance Criteria and Test Plan

### 12.1 Unit tests (Vitest, in `src/features/security/lib/__tests__/`)

**BOLA check — positive fixture**:

- Given: `resultA` with status 200 and body `{"id":1042,"email":"alice@example.com","balance":500}`, `resultB` with status 200 and same body, identity fields `["id","email"]`
- Expected: `detectBola(resultA, resultB, identityFields)` returns `{ finding: true, matchedFields: ["id","email"] }`

**BOLA check — negative fixture (correct 403)**:

- Given: `resultA` 200, `resultB` 403 with empty body
- Expected: `detectBola()` returns `{ finding: false }`

**BOLA check — negative fixture (public endpoint)**:

- Given: original request has `auth.type === 'none'`
- Expected: `runBolaCheck()` returns `{ skipped: true, reason: 'no-auth' }`

**Auth-strip check — pass**:

- Given: stripped replay returns status 401
- Expected: `detectAuthStrip(401)` returns `{ finding: false }`

**Auth-strip check — fail (missing gate)**:

- Given: stripped replay returns status 200
- Expected: `detectAuthStrip(200)` returns `{ finding: true, severity: 'high' }`

**Cookie jar isolation**:

- Assert: BOLA replay options always have `settings.disableCookieJar === true`
- Assert: auth-strip replay options always have `settings.disableCookieJar === true`

**Passive hygiene — header rules**:

- `runHeaderChecks({ headers: {} })` returns finding for H01, H02, H03
- `runHeaderChecks({ headers: { 'Strict-Transport-Security': 'max-age=31536000' } })` does NOT return H01
- `runHeaderChecks({ headers: { 'Access-Control-Allow-Origin': '*' } })` returns H08

**Passive hygiene — body rules**:

- `runBodyChecks('{"password":"hunter2"}')` returns finding D02
- `runBodyChecks('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')` returns finding D03 with severity Critical
- `runBodyChecks('{"username":"alice"}')` does NOT return D02 (key `username`, not `password`)

**No parallel transport**:

- Confirm (via import graph / mock) that `bolaRunner.ts` imports `executeRequest` from `requestExecutor.ts` and makes no direct call to `fetch`, `executeProxiedRequest`, or any IPC channel.

### 12.2 Integration / e2e tests (Playwright, against echo server `echo/`)

The echo server (`echo/wrangler.jsonc`) needs two new endpoints for security test fixtures:

- `GET /security/echo/profile/{userId}` — returns `{"id":{userId},"email":"user{userId}@example.com"}` only when `Authorization: Bearer user{userId}-token` is present; otherwise 403.
- `GET /security/echo/public` — returns `{"status":"ok"}` with no auth check (for public-endpoint skip test).

**BOLA positive e2e**:

- Environment "Alice" with `token=user1-token`, Environment "Bob" with `token=user2-token`
- Request: `GET /security/echo/profile/1` with `Authorization: Bearer {{token}}`
- Run BOLA check (A=Alice, B=Bob, identityFields=["id"])
- **But**: the echo endpoint enforces auth, so Bob should get 403 → BOLA negative
- To test BOLA positive: temporarily make the echo endpoint return Alice's data for any valid token (a "permissive" variant endpoint)

**Auth-strip positive e2e**:

- Request: `GET /security/echo/profile/1`
- Auth-strip replay (no Authorization header)
- Expected: echo returns 403 → auth-strip passes (finding: false)

**BOLA positive e2e (permissive endpoint)**:

- `GET /security/echo/profile-permissive/1` returns `{"id":1}` regardless of token
- Run BOLA check (A=Alice, B=Bob)
- Expected: finding emitted with `severity: high`

### 12.3 Security regression tests (`tests/security/`)

Add `tests/security/bola-ssrf.test.ts`:

- Assert that `bolaRunner.runRequest()` with a B-identity URL modified to `http://169.254.169.254` is rejected by `validateURL` (never reaches `fetch`)
- Assert that `bolaRunner.runRequest()` with a B-identity URL pointing to a private IP (`http://10.0.0.1`) is rejected
- Assert that the harness does not forward auth headers from identity A to the auth-strip replay

### 12.4 Header forwarding verification

Add a test that mocks `executeProxiedRequest` to return a response with `Strict-Transport-Security: max-age=31536000` in headers and confirms `passiveHygiene.runHeaderChecks()` does NOT flag H01 (i.e., the header survives the round trip). This is a regression guard for §8.4.

---

## 13. Success Metrics

Metrics are organized by phase. None are currently baselined; tracking requires instrumentation via the existing `/api/telemetry/error` sink (web) or Sentry telemetry (desktop, opt-out).

**Phase 1 metrics (3 months post-launch)**:

| Metric                                                  | Target                                          | Rationale                                                 |
| ------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Weekly Active Users running at least one security check | >5% of WAU                                      | Validates in-client demand hypothesis                     |
| BOLA check completion rate                              | >80% of initiated checks complete without error | Guards against UX friction or config confusion            |
| Passive findings per-session dismiss rate               | <30% dismissed immediately                      | High dismiss rate signals too many false positives        |
| Auth-strip failure rate across user bases               | Track distribution                              | Understanding how many endpoints actually lack auth gates |
| User-reported false-positive rate                       | <15% of High/Critical findings                  | Quality signal for rule tuning                            |

**Phase 2 metrics (OpenAPI fuzz)**:

- Count of fuzz-generated requests per session
- 400/422 vs 2xx rate on fuzz requests (signal of how well APIs validate inputs)

**Long-term (6 months)**:

- Retention correlation: do users who engage with security features show higher 30-day retention?
- NPS delta for security-feature users vs non-users

---

## 14. Rollout Phases

### Phase 1 — Core security primitives (estimated 6–8 weeks engineering)

**Goal**: Ship BOLA replay, auth-strip, and passive hygiene. No OpenAPI dependency.

**Milestones**:

1. `passiveHygiene.ts` with H01–H08 and D01–D07 rules; unit tests green
2. Passive findings surfaced in per-request Security tab (read-only, no additional network calls)
3. `bolaRunner.ts` with `disableCookieJar` enforcement; BOLA+auth-strip unit tests green
4. Identity picker UI; BOLA check triggered from Security tab
5. `securityFindings` Dexie table (version 14 migration); findings panel
6. Echo server test endpoints; e2e tests green
7. Security regression tests in `tests/security/` green
8. Capability matrix updated; `capabilities:check` green
9. Ethical use notice UI
10. Soft launch (feature flag gated) → collect initial usage data

### Phase 2 — OpenAPI negative fuzzing (estimated 4–6 weeks post Phase 1)

**Goal**: Generate and run schema-violating requests for operations with attached OpenAPI specs.

**Milestones**:

1. `negativeRequestGenerator.ts` consuming `OperationMatch`; unit tests cover boundary, type, enum, extra-field cases
2. Base-URL-from-env enforcement with test coverage
3. Collection-level fuzz runner integrated into `useSecurityRun.ts`
4. Findings surfaced under `checkType: 'fuzz'` in findings panel
5. e2e test against echo server with schema-enforcing endpoint

### Phase 3 — Intelligence and integrations (future, not committed)

- Infer identity fields from OpenAPI response schemas (auto-populate identity picker)
- Export findings to SARIF format for GitHub Code Scanning integration
- GitHub Actions / CI integration for collection-level security scan (extend `@restura/cli`)
- Consider: AI-assisted false-positive triage (would require ADR)

---

## 15. Risks and Open Questions

### R1 — In-client demand is unproven (HIGH probability, HIGH impact)

The core product hypothesis — that developers want BOLA testing inside an API client rather than a dedicated scanner — is inferred from competitive analysis, not validated by user research. If adoption is low, Phase 2 and Phase 3 should not proceed.
**Mitigation**: Feature-flag the release; measure §13 metrics aggressively in Phase 1; interview 5–10 users about their current authorization testing workflow before committing to Phase 2.

### R2 — False positive rate undermines trust (MEDIUM probability, HIGH impact)

BOLA's volatile-field comparison problem (timestamps, pagination cursors, request IDs all differ between A and B legitimately) could produce noisy results if identity-field configuration is unclear or defaulted wrong. Passive body rules for email and JWT patterns will fire on valid API responses.
**Mitigation**: Default to status-code-only BOLA (low-confidence) when no identity fields are configured; require explicit identity-field selection for high-confidence findings. Make passive info/low findings collapsible with a "hide info-level" toggle. Tune rule D05 (email) to only fire on non-profile paths.

### R3 — Scope creep toward full DAST (LOW probability, HIGH impact)

The moment a user asks "can it also scan for SQLi?" or "can it follow redirects to find open redirects?" the feature scope expands rapidly toward a DAST scanner, which is explicitly not the goal (NG1).
**Mitigation**: Maintain a short, versioned rule catalog with an explicit process for adding new rules (requires ADR). Decline requests for exploit-payload delivery or automated bypass sequences.

### R4 — Responsible disclosure framing (MEDIUM probability, MEDIUM impact)

Users may run security checks against APIs belonging to others (public APIs with real user data). The ethical notice (§9.5) is a soft guardrail only.
**Mitigation**: The ethical use notice is a clear product position, not a legal backstop. Legal review is required before shipping to determine whether terms of service need to address authorized testing scope.

### R5 — Cookie-jar contamination causing systematic false-negatives (LOW probability after fix, HIGH impact if missed)

If `disableCookieJar: true` is not enforced on B replays, identity A's session cookies leak into B's replay and the BOLA check returns a false-negative on every session-cookie-authenticated endpoint.
**Mitigation**: Unit test explicitly asserts that replay options always set `disableCookieJar: true` (§12.1). This is a non-negotiable correctness requirement, not a usability preference.

### R6 — Security header forwarding gaps (MEDIUM probability, MEDIUM impact)

If the Cloudflare Worker or Electron HTTP handler drops `Strict-Transport-Security`, `Content-Security-Policy`, or `Set-Cookie` from the `ProxyJsonResponse.headers` map, passive header checks will produce false-positive findings.
**Mitigation**: Add header forwarding coverage to the existing security test suite before Phase 1 ships (§12.4).

### Open questions

- **OQ1**: Should the findings panel be a first-class tab in the main sidebar (like the existing "Runs" panel), or embedded in the response panel per-request only? The collection-level scan argues for a sidebar location; the passive hygiene flow argues for the response panel.
- **OQ2**: What is the correct behavior when the user has no second environment configured? Options: (a) block BOLA, show "create environment" CTA; (b) allow BOLA with a manually entered token; (c) allow environment cloning from within the picker. Phase 1 implements (a) only.
- **OQ3**: Should the auth-strip check automatically run as a passive check on every request, or only on-demand? Running it passively would double every request's network cost — probably too aggressive for default-on behavior.
- **OQ4**: For Phase 2 fuzz, what is the right request cap per operation to avoid accidentally overwhelming a staging server? 10–20 generated requests per operation is a reasonable starting assumption **[assumption]**; needs user validation.
- **OQ5**: Does the CLI (`@restura/cli`) need security scan support in Phase 1, or is Phase 1 UI-only? CLI integration is a Phase 3 candidate.

---

## 16. Round-2 Review Addendum (verified findings)

Round-1 symbol claims all re-confirmed. The "no parallel execution path" architecture **survives** deeper scrutiny (auth is options-derived via `buildAuthCredential`/`envVars`, not store-coupled) — **but only if the three correctness gaps below are closed**, otherwise A/B isolation silently leaks.

| #    | Tag         | Sev          | Finding                                                                                                                                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                                                    |
| ---- | ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-1 | CORRECTNESS | **Critical** | `executeRequest` has no skip-scripts flag; a cloned request's pre-request script runs unconditionally and can `Object.assign(envVars, …)` / mutate `useGlobalsStore` **after** identity B is injected — overwriting B's token and defeating isolation (`requestExecutor.ts:354-391`). §8.1 mandates skipping scripts but the code example never clears them. | Add `skipScripts?: boolean` to `RequestExecutorOptions`; gate script execution on it; pass `skipScripts:true` for all A/B/auth-strip replays AND clear `preRequestScript`/`testScript` on the clone.                                                                   |
| R2-2 | SECURITY    | High         | Identity A's replay isn't cookie-isolated; A's `Set-Cookie` flows into the shared `useCookieStore` (`requestExecutor.ts:403`), contaminating later requests in a collection sweep.                                                                                                                                                                           | Force `disableCookieJar:true` on A (and B), or reuse the already-captured A `ApiResponse` instead of re-running A.                                                                                                                                                     |
| R2-3 | CORRECTNESS | High         | Auth-strip sets `auth:{type:'none'}` but does NOT remove a manually-added `Authorization`/`X-API-Key` header sitting in `request.headers` (`requestExecutor.ts:178-195`) → endpoint still authenticates → false-positive "missing auth gate."                                                                                                                | Filter auth-bearing header keys out of `request.headers` before the strip replay; add a §12.3 fixture with a manual `Authorization` header.                                                                                                                            |
| R2-4 | SECURITY    | High         | §9.1 attributes the full SSRF guard (CGNAT, IPv4-mapped-IPv6, encoded cloud-metadata) to the replay path, but `requestExecutor.ts` imports the **renderer** `urlValidator` which lacks those; the robust guard runs at the backend proxy layer. The §12.3 test (`http://169.254.169.254`) misses encoded forms.                                              | Attribute SSRF enforcement to the backend (`shared/protocol/url-validation.ts`); add encoded-metadata test cases (e.g. IPv4-mapped-IPv6 form).                                                                                                                         |
| R2-5 | CORRECTNESS | **RESOLVED** | BOLA identity-field comparison was unspecified.                                                                                                                                                                                                                                                                                                              | **Decided: user-specified JSON paths** via lodash `get` (nested + indexed-array support), exact-match, explicit `undefined`/`null`/missing rules + status-only fallback for array responses without element paths. Specified in §6.2; add nested + array §12 fixtures. |
| R2-6 | CONSISTENCY | High         | `securityFindings` Dexie table (§10.1) needs the full migration, not just a `version(14)` mention: table declaration on `ResturaDB`, `StorageTableName` union, `clearAllData`/`exportAllData`/`importAllData`. Model on `collectionRuns`.                                                                                                                    | Add a Dexie integration checklist to §10.1.                                                                                                                                                                                                                            |

**Plus** (low): improve the desktop-only handle error to name identity B; §9.4 "held in memory then discarded" is non-persistence (true) not memory-scrubbing — reword.
