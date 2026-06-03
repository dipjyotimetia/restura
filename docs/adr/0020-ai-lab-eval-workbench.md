# ADR 0020: AI Lab — prompt/model eval workbench

**Status:** Accepted, 2026-06-03

## Context

Restura already ships an [AI assistant](./0010-ai-assistant-architecture.md) — a request-aware chat panel that talks to OpenAI, Anthropic, and OpenRouter through a provider-agnostic core (`shared/protocol/ai`). That core can stream a single chat against a known-safe cloud endpoint. It does not cover the _other_ thing developers want from a model: systematically **testing** a prompt — comparing models, running it over a dataset, and grading the outputs — including against **local** runtimes (Ollama, LM Studio, vLLM) that live on `localhost`.

Two things make this more than "reuse the chat panel":

1. **Local runtimes need localhost.** The SSRF guard ([ADR 0004](./0004-security-hardening.md)) blocks loopback for every existing path — correctly, since the cloud assistant never has a reason to hit `127.0.0.1`. A prompt-testing tool that targets Ollama _must_ reach loopback, but must not thereby open a hole to LAN, private ranges, or cloud-metadata.
2. **Evals are a fan-out, not a stream.** Grading needs a non-streaming completion per (case × model) cell, structured-output calls (judge, dataset generation), and scorers that run untrusted user code — a shape the streaming chat orchestrator doesn't provide.

## Decision

Add **AI Lab** as a **separate, Electron-only feature** (`src/features/ai-lab`) that reuses the AI provider core but layers its own engine, stores, and a provider-kind-aware security carve-out.

**Provider model.** Widen the `Provider` union into `CloudProvider` (openai/anthropic/openrouter) and `LocalProvider` (ollama/openai-compatible), with `isLocalProvider()` as the single predicate. Ollama and OpenAI-compatible share one route — the OpenAI wire shape — differing only in that auth is optional and the base URL is user-supplied. The OpenAI decoder is reused unchanged.

**Security — loopback-only carve-out through the same guard.** The Electron AI Lab handler sets `allowLocalhost = isLocalProvider(provider)` and passes it into the _same_ shared SSRF guard every other path uses. Local providers may reach `127.0.0.1` / `::1` and nothing else; LAN, RFC 1918/6598, link-local, IPv6 unique-local, and metadata stay blocked for everyone, across redirects and DNS rebind. Cloud providers get no carve-out. There is no second guard implementation to drift.

**Eval engine (renderer).** `ai-complete.ts` drains the provider stream to one `CompletionResult`. The runner sweeps (case × model) cells at bounded concurrency, with cancel via `AbortSignal`. Only the model call crosses IPC; scorers run in the renderer — including the `json-schema` (Ajv) and `script` scorers, the latter on the existing [QuickJS sandbox](./0015-quickjs-script-sandbox.md). The `judge` and dataset-generation paths use structured output (a tool call), the same discipline as the agent layer. Cost is `null` (unknown) for unpriced gateways rather than coerced to `$0`, so a cost-threshold scorer can't be satisfied by a missing estimate.

**Persistence.** New `aiLab` and `evalRuns` Dexie tables with Zod validators; `evalRuns` uses the shared `debouncedStorage` wrapper because runs write progress frequently. API keys are [`SecretRef`](./0007-secret-ref-pattern.md) handles, never plaintext in the store.

**Capabilities.** Four `aiLab.*` rows (`basic`, `localProviders`, `evals`, `judge`) added to `capabilities.ts` — the [single source of truth](./0012-capability-matrix-source-of-truth.md) — all web:false / desktop:true.

## Consequences

**Positive**

- Local-model testing without weakening the guard: one predicate, one guard, loopback-only.
- Adding a local runtime is a base URL, not new code — anything OpenAI-compatible already works.
- Deterministic scorers stay pure and unit-testable; the judge/script capabilities are injected, not imported, so the engine has no mocked dependencies in tests.
- The provider-union split is reusable: a future Worker AI path could adopt the same `CloudProvider`/`LocalProvider` shape.

**Negative**

- Desktop-only. Like the AI assistant's web gap, there is no Worker route — recorded in the capability matrix, not hidden.
- A new feature surface (5 tabs, two stores, an engine) to maintain alongside the assistant; they share the provider core but diverge above it.
- `script` scorers run user code; safety rests entirely on the QuickJS sandbox boundary (ADR 0015), now exercised by a second caller.

## References

- Code: `src/features/ai-lab/`, `electron/main/ai-lab-handler.ts`, `shared/protocol/ai/{ai-complete,model-discovery,provider-routes,types}.ts`
- Security tests: `tests/security/ai-lab-localhost-policy.test.ts`
- Related: [ADR 0010 (AI assistant)](./0010-ai-assistant-architecture.md), [ADR 0004 (security hardening)](./0004-security-hardening.md), [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md), [ADR 0015 (QuickJS sandbox)](./0015-quickjs-script-sandbox.md), [ADR 0012 (capability matrix)](./0012-capability-matrix-source-of-truth.md)
