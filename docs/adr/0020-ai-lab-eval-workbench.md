# ADR 0020: AI Lab — prompt/model eval workbench

**Status:** Accepted, 2026-05-20

## Context

Restura already ships an [AI assistant](./0010-ai-assistant-architecture.md) — a request-aware chat panel that talks to OpenAI, Anthropic, and OpenRouter through a provider-agnostic core (`shared/protocol/ai`). That core can stream a single chat against a known-safe cloud endpoint. It does not cover the _other_ thing developers want from a model: systematically **testing** a prompt — comparing models, running it over a dataset, and grading the outputs — including against **local** runtimes (Ollama, LM Studio, vLLM) that live on `localhost`.

Two things make this more than "reuse the chat panel":

1. **Local runtimes need localhost.** The SSRF guard ([ADR 0004](./0004-security-hardening.md)) blocks loopback for every existing path — correctly, since the cloud assistant never has a reason to hit `127.0.0.1`. A prompt-testing tool that targets Ollama _must_ reach loopback, but must not thereby open a hole to LAN, private ranges, or cloud-metadata.
2. **Evals are a fan-out, not a stream.** Grading needs a non-streaming completion per (case × model) cell, structured-output calls (judge, dataset generation), and scorers that run untrusted user code — a shape the streaming chat orchestrator doesn't provide.

## Decision

Add **AI Lab** as a **separate, Electron-only feature** (`src/features/ai-lab`) that reuses the AI provider core but layers its own engine, stores, and a provider-kind-aware security carve-out.

**Provider model.** Widen the `Provider` union into `CloudProvider` (openai/anthropic/openrouter) and `LocalProvider` (ollama/openai-compatible), with `isLocalProvider()` as the single predicate. Ollama and OpenAI-compatible share one route — the OpenAI wire shape — differing only in that auth is optional and the base URL is user-supplied. The OpenAI decoder is reused unchanged.

**Security — loopback-only carve-out through the same guard.** The Electron AI Lab handler sets `allowLocalhost = isLocalProvider(provider)` and passes it into the _same_ shared SSRF guard every other path uses. Local providers may reach `127.0.0.1` / `::1` and nothing else; LAN, RFC 1918/6598, link-local, IPv6 unique-local, and metadata stay blocked for everyone, across redirects and DNS rebind. Cloud providers get no carve-out. There is no second guard implementation to drift.

**Eval engine (renderer).** `ai-complete.ts` drains the provider stream to one `CompletionResult`. The runner sweeps (case × model) cells at bounded concurrency, with cancel via `AbortSignal`. Only the model call crosses IPC; scorers run in the renderer — including the `json-schema` (Ajv) and `script` scorers, the latter on the existing [QuickJS sandbox](./0015-quickjs-script-sandbox.md). The `judge` and dataset-generation paths use structured output (a tool call), the same discipline as the agent layer. Cost is `null` (unknown) for unpriced gateways rather than coerced to `$0`, so a cost-threshold scorer can't be satisfied by a missing estimate. Model calls are wrapped in transient-only retry/backoff (`completeRetry.ts`) so a single network blip or provider 429/5xx mid-sweep fails one cell at most — not a whole run — which would otherwise read as a false regression in CI.

**Judge hardening — one engine, two consumers.** The LLM-as-judge is `shared/protocol/ai/judge.ts`, the single source of truth for the AI Lab `judge` scorer **and** the `rs.judge` script assertion (`src/lib/shared/judgeBridge.ts`, bound into the [QuickJS sandbox](./0015-quickjs-script-sandbox.md)). `runJudge(input, complete)` owns the whole algorithm — callers inject only transport. It supports: **multi-criteria weighted rubrics** (each criterion scored independently; `gate` criteria fail the verdict regardless of the weighted score — e.g. a "no PII" gate); **self-consistency** (`samples` runs the judge N≤5 times and aggregates by per-criterion median, reporting score variance to expose a noisy judge); and **calibration anchors** (reference-scored examples that pin the 0–1 scale). The single-`rubric` form is preserved verbatim for back-compat. This hardening is the credibility floor for every downstream use (CI gating, regression diff) — a single stochastic call with one rubric is too brittle to gate on.

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

## Addendum (2026-06-24): expanded scorers, datasets, Arena, http-exec

The workbench grew along five axes, all following the patterns above (engine in the renderer, judge algorithm in `shared/protocol/ai/judge.ts`, encrypted `NamedEncryptedRecord` Dexie persistence):

- **Scorers.** Added `tool-call` (function-call correctness — the called tool name + args validate against a JSON schema / expected JSON) and `pairwise` (preference judging). Pairwise reuses a new `runPairwiseJudge` in the shared judge engine — head-to-head A/B with optional **position-bias swap** (run both orderings; a flip-flop collapses to a tie), the LMArena/MT-Bench standard.
- **Datasets.** Beyond hand-written + OpenAPI generation: import from request **history/collections** (`lib/datasetFromHistory.ts`; request URL/headers/body **and** captured response body redacted via `shared/protocol/ai/redaction.ts` before anything reaches a model), **CSV/JSONL** import/export, **adversarial/red-team** generation, and **multi-turn** conversation cases.
- **Arena.** A round-robin pairwise model-vs-model tab → **Elo** leaderboard + win-rate matrix (`Arena.tsx`, `lib/elo.ts` — deterministic, fixed K-factor — `lib/arenaRunner.ts`, `store/useArenaStore.ts`). Persisted to a new `arenaRuns` Dexie table (`database.ts` version 13), reusing the existing encrypted-record persistence decision ([ADR 0014](./0014-zustand-persistence.md)).
- **Reports.** CSV/JSON/Markdown export, per-case drill-down, and cross-model output diff.
- **http-exec target.** The most consequential addition — recorded separately in [ADR 0023](./0023-ai-lab-http-exec.md): an eval cell can parse an HTTP/GraphQL request out of the model output and **execute it through the real request executor**, scoring the upstream response. The decision to reuse `executeRequest` (inheriting the SSRF guard, redirects, cookie jar) rather than build a parallel client is a security-boundary choice — see 0023.

Capabilities grew to six `aiLab.*` rows (added `httpExec`, `arena`); the feature is now six tabs and three stores. Persistence is now `aiLab` / `evalRuns` / `arenaRuns`.

## Addendum (2026-07-13): agent engineering workbench

AI Lab now also evaluates multi-step agents, not only single completions. The backend-agnostic core lives in `shared/agent-lab/` so Electron authoring and the Node CLI consume exactly the same schemas, runner, traces, graders, and statistics.

- **Portable suites.** `AgentSuiteSchema` v2 describes open provider/model references, typed multimodal content, agent instructions, MCP/Restura/sandbox tool sources, hard budgets, tasks, graders, and repeated trials. Credentials are references to environment variables or desktop secret handles; inline secret values are invalid. The Zustand store validates suites at its write and rehydration boundaries and migrates the previous AI Lab state by adding an empty suite map.
- **Capability-driven providers.** Provider identifiers are open strings. Adapters publish capabilities instead of relying on model-name conditionals. Profiles cover OpenAI Responses and Chat, Anthropic Messages, Gemini GenerateContent, Azure OpenAI, Bedrock Converse, OpenRouter, Ollama, Hugging Face, and generic OpenAI-compatible gateways. The dedicated OpenAI Responses adapter supports tool calls, structured output, reasoning summaries, continuation, multimodal input, usage, and model discovery. Other transports plug into `CallbackProviderAdapter`; the existing Electron AI Lab transport provides today’s shipped OpenAI/Anthropic/OpenRouter/Ollama/Hugging Face/compatible paths.
- **Agent loop and safety.** `AgentRunner` records a strictly ordered typed trace and enforces steps, wall time, tool calls, tokens, cost, and cumulative model/tool output bytes. Read-only Restura HTTP tools execute through the normal request executor. Mutating or otherwise sensitive tools pause for explicit approval and fail closed when no approver exists. MCP tools honor allowlists, but server-supplied safety annotations never grant approval-free execution; a local trust policy is required before that can change. Sandboxes use a provider registry and a network/timeout/output-limited contract; no sandbox provider is claimed as shipped yet.
- **Evaluation and observability.** Outcome, tool, latency, cost, and exact/in-order/subsequence/unordered trajectory graders run over complete traces. Repeated trials report per-agent/task pass rate, Wilson 95% confidence intervals, pass@k, and pass^k with explicit macro aggregation. Judge panels expose agreement and fail closed on ties; calibrated mode first measures label accuracy and score error against anchors and refuses an uncalibrated panel. Traces export as opt-in OTLP/HTTP JSON with OpenInference span attributes; nothing is transmitted automatically.
- **Surfaces.** Electron adds an Agents tab with schema-validated JSON import/export, persistence, execution, approval prompts, and reliability summaries. `restura agent eval <suite.json> [--output report.json]` runs OpenAI Responses suites headlessly with environment-variable credentials and non-zero CI exit status. CLI base-URL overrides and unregistered tool adapters are refused rather than silently weakening the security boundary.

The capability matrix intentionally distinguishes fully wired features from extension contracts: saved Restura HTTP tools are supported on desktop, while MCP connection resolution and concrete sandbox providers remain marked unsupported until wired end-to-end.

## References

- Code: `src/features/ai-lab/`, `shared/agent-lab/`, `electron/main/handlers/ai-lab-handler.ts`, `shared/protocol/ai/{ai-complete,model-discovery,provider-routes,types,judge}.ts`, `src/lib/shared/{judgeBridge,completeRetry}.ts`, `cli/src/commands/agent.ts`
- Security tests: `tests/security/ai-lab-localhost-policy.test.ts`
- Related: [ADR 0010 (AI assistant)](./0010-ai-assistant-architecture.md), [ADR 0004 (security hardening)](./0004-security-hardening.md), [ADR 0007 (SecretRef)](./0007-secret-ref-pattern.md), [ADR 0015 (QuickJS sandbox)](./0015-quickjs-script-sandbox.md), [ADR 0012 (capability matrix)](./0012-capability-matrix-source-of-truth.md), [ADR 0023 (AI Lab http-exec)](./0023-ai-lab-http-exec.md)
