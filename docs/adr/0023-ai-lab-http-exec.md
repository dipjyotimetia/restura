# ADR 0023: AI Lab http-exec — scoring AI-generated requests through the real executor

**Status:** Accepted, 2026-06-24

## Context

[AI Lab](./0020-ai-lab-eval-workbench.md) evals score a model **completion**: render a prompt, call the model, grade the text. But Restura's differentiator is that it is an API client with real protocol executors. The higher-value question for an API-generation prompt is not "did the model say the right words" but "did the model produce a request that actually **works**" — correct method, URL, headers, body, against a real upstream.

Answering that means executing a model-authored request. The design tension: doing so must not open a new outbound path that bypasses the SSRF guard ([ADR 0004](./0004-security-hardening.md)). A naive "just fetch the URL the model gave us" in the renderer would be exactly such a bypass.

## Decision

Add an **`http-exec` eval target** (`EvalConfig.target`). When set, a cell runs `prompt → complete → parse a request out of the output → EXECUTE it → score the upstream response` instead of scoring the model prose.

- **Parse, don't trust.** `lib/requestExtractor.ts` is a pure parser: it pulls a `{ method, url, headers?, body? }` object out of the completion (a bare JSON object, or the first fenced ```json block), method-allowlisted to a fixed set, never throwing — a parse failure fails the cell cleanly. No `eval`, no template execution.
- **Reuse the real executor, never a parallel client.** `lib/execCell.ts` builds a minimal `HttpRequest` (`auth: { type: 'none' }`) and calls `executeRequest()` (`src/features/http/lib/requestExecutor.ts`) — the exact function user-issued requests use. So the model-authored request inherits the **renderer pre-check + the authoritative proxy-layer SSRF/DNS guard, redirect policy, and cookie jar** with zero new addressing code. There is no second transport to drift. GraphQL is the same path with a forced POST + JSON content type.
- **Inject the executor into the runner.** The eval runner (`lib/evalRunner.ts`) stays pure/unit-testable: it receives `runRequest` injected (the hook supplies `executeExtractedRequest`), parallel to how the judge/script capabilities are injected. The executed response body becomes the scoring input; existing scorers (`contains`, `json-schema`, `script`, `judge`, …) grade the real upstream result. An `executed` summary (status, latency, body excerpt) is stored on the cell.

## Consequences

**Positive**

- Evals can assert that a generated request _works_, not just that it reads correctly — unique to Restura's position as an API client.
- No new SSRF surface: model-authored URLs flow through the same chokepoint as hand-typed ones. Private/CGNAT/link-local/loopback/cloud-metadata stay blocked across redirects and DNS rebind. (Verified: the security audit found no new outbound path.)

**Negative / residual risk**

- The **model**, not the user, now chooses the URL/method/body of a live outbound request. Within the SSRF boundary it can still reach any **public** endpoint the user could reach manually, and a poisoned dataset/prompt could steer it (e.g. an exfil beacon). This is acceptable for a desktop power-user tool but is surfaced: the EvalBuilder shows an explicit warning on the http-exec target, mirroring the AI assistant's "Send raw" affordance.
- `executeRequest` attaches the cookie jar for the resolved origin. Cookies only attach for origins the user already holds cookies for, so this is not a leak to an arbitrary attacker origin unless the model targets that same origin — in scope of the residual-risk note above.
- The executed response body feeds scorers/judges and is persisted to `evalRuns` verbatim. This matches the existing eval posture (model outputs are already persisted unredacted); pattern-based redaction is best-effort and opaque secrets in a response body are not caught — the same documented residual risk as the AI assistant.

## References

- Code: `src/features/ai-lab/lib/{requestExtractor,execCell,evalRunner}.ts`, `src/features/http/lib/requestExecutor.ts`
- Security: `shared/protocol/url-validation.ts`, `electron/main/security/dns-guard.ts`; tests `tests/security/{ssrf,http-executor-no-fallback}.test.ts`
- Related: [ADR 0020 (AI Lab)](./0020-ai-lab-eval-workbench.md), [ADR 0004 (security hardening)](./0004-security-hardening.md), [ADR 0012 (capability matrix)](./0012-capability-matrix-source-of-truth.md)
