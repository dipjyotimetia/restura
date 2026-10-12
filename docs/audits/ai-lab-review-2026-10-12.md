# AI Lab review — 2026-10-12

Scope: the desktop AI Lab (`src/features/ai-lab/`), the shared agent core (`shared/agent-lab/`), the AI protocol core (`shared/protocol/ai/`), `electron/main/handlers/ai-lab-handler.ts` and its IPC validators, and `restura agent eval` (`cli/`). Baseline commit `e2dfaaa6`. Tracking epic: [#1057](https://github.com/dipjyotimetia/restura/issues/1057).

Method: read-only code inspection plus targeted gates. All gates were green when this was written, so **none of the bugs below is caught by the current suite**:

| Gate | Result |
|---|---|
| `vitest run src/features/ai-lab shared/agent-lab shared/protocol/ai` | 68 files / 570 tests pass |
| `vitest run electron/main/__tests__/ai-lab-handler*` | 2 files / 37 tests pass |
| CLI agent tests (`cli/src/{commands,runner}/__tests__/agent*`) | 5 files / 25 tests pass |
| `npm run type-check:all` | 0 errors |

Severity: **P1** broken or misleading for a common case, or a security boundary issue · **P2** less common or defence-in-depth · **P3** polish.

## 1. What exists today

Everything is **desktop-only**. On web, `AiLabWorkspace.tsx` renders a placeholder. Every `aiLab.*` capability is `web:false, desktop:true`, except `aiLab.agentSandboxes`, which is false on both.

| Area | What ships | Key files |
|---|---|---|
| Providers | OpenAI, Anthropic, OpenRouter (cloud); Hugging Face (AI Lab only); Ollama and OpenAI-compatible (local, with a localhost carve-out). Model discovery and a connection test. Keys stored as `SecretRef` handles | `shared/protocol/ai/providers/index.ts`, `model-discovery.ts`, `components/ProviderManager.tsx` |
| Playground | Streams one prompt to several models, with `{{var}}` templates and "save as cases" | `components/Playground.tsx` |
| Datasets | Multi-turn cases; JSONL/CSV import and export; import from history or collections (redacted); OpenAPI-generated and red-team-generated cases | `lib/datasetIo.ts`, `lib/datasetFromHistory.ts`, `lib/openapiTestGen.ts`, `lib/redteamGen.ts` |
| Eval runner | Runs case × model cells through a bounded pool with retry, on the unified RunEngine | `lib/evalRunner.ts`, `run-engine/` |
| Scorers | exact-match, contains, regex, json-valid, json-schema, latency, cost, script (QuickJS), tool-call, pairwise, judge | `lib/scorers.ts` |
| Judge | Multi-criteria weighted judge with gates, self-consistency (≤5), anchors, variance, and pairwise judging with a position swap; `rs.judge` in scripts | `shared/protocol/ai/judge.ts` |
| http-exec target | Extracts a request from model output and runs it through the real request executor (ADR 0023) | `lib/requestExtractor.ts`, `lib/execCell.ts` |
| Arena | Round-robin pairwise judging, Elo ratings and a win-rate matrix | `lib/arenaRunner.ts`, `lib/elo.ts` |
| Agents | Suite schema v3; tool sources restura-request and MCP (wired), plus fixture, sandbox and a2a (contract or schema only); graders; pass@k and Wilson intervals; bundles with baseline gates; approvals for non-read tools | `shared/agent-lab/`, `lib/agentRuntime.ts`, `lib/agentTools.ts` |
| Telemetry | OTLP and Langfuse export, metadata only (desktop and CLI) | `shared/agent-lab/telemetry.ts`, `docs/AGENT_TELEMETRY.md` |
| Reports | CSV, JSON and Markdown export; regression delta against the previous run | `components/ReportView.tsx`, `lib/reportExport.ts` |
| CLI | `restura agent eval` only: OpenAI Responses and Anthropic Messages; saved-HTTP and read-only MCP tools from a runtime manifest | `cli/src/commands/agent.ts` |
| Persistence | Dexie tables `aiLab`, `evalRuns` (v11) and `arenaRuns` (v13), stored encrypted | `src/lib/shared/database.ts` |

Checked and clean: IPC wiring (all 7 channels registered and disposed); additive Dexie migrations; dispatch for all 11 scorer kinds; late success after a cancel stays cancelled (evals, agents); concurrent starts on the same surface are rejected; API keys stay as handles only; CLI claims (`store:false`, environment credentials, refusal of judges, handles and base-URL overrides).

## 2. Bugs (filed)

| # | Finding | Sev | Evidence |
|---|---|---|---|
| [#1019](https://github.com/dipjyotimetia/restura/issues/1019) | The tool-call scorer can never pass because EvalBuilder never offers tools | P1 | `components/EvalBuilder.tsx:140-151`, `lib/scorers.ts:238` |
| [#1020](https://github.com/dipjyotimetia/restura/issues/1020) | Stopping an Arena run does not cancel in-flight contestant or judge calls | P1 | `lib/arenaRunner.ts:88-109` |
| [#1021](https://github.com/dipjyotimetia/restura/issues/1021) | Agent `maxTokens` is sent as the per-call output cap; values above 32768 fail on desktop | P1 | `shared/agent-lab/runner.ts:281-292` |
| [#1022](https://github.com/dipjyotimetia/restura/issues/1022) | CLI `maxCostUSD` budgets and the cost grader always fail | P1 | `shared/agent-lab/runner.ts:382` |
| [#1023](https://github.com/dipjyotimetia/restura/issues/1023) | Arena turns provider failures into silent ties and reports `done` | P1 | `lib/arenaRunner.ts:90-139`, `hooks/useArenaRun.ts:82-85` |
| [#1024](https://github.com/dipjyotimetia/restura/issues/1024) | Eval reports always say `passed` | P1 | `run-engine/reportEnvelope.ts:267-268` |
| [#1025](https://github.com/dipjyotimetia/restura/issues/1025) | The 50-run eval history cap is bypassed by `runReports` | P2 | `run-engine/reportSanitizer.ts:45-60` |
| [#1026](https://github.com/dipjyotimetia/restura/issues/1026) | The CLI overrides the MCP `destructiveHint` | P1 · security | `cli/src/runner/agentTools.ts:136` |
| [#1027](https://github.com/dipjyotimetia/restura/issues/1027) | `isCiSafePolicy` is never enforced | P2 · security | `shared/agent-lab/policy.ts:46-48` |
| [#1028](https://github.com/dipjyotimetia/restura/issues/1028) | `rawMode: true` turns off the secret check for cloud providers | P1 · security | `lib/llmClient.ts:42-46` |
| [#1029](https://github.com/dipjyotimetia/restura/issues/1029) | Importing a dataset from history doesn't strip environment or secret values | P1 · security | `lib/datasetFromHistory.ts:39-53` |
| [#1030](https://github.com/dipjyotimetia/restura/issues/1030) | One invalid persisted record wipes the whole store | P1 | `store/useAiLabStore.ts:481-485` |
| [#1031](https://github.com/dipjyotimetia/restura/issues/1031) | A failed report save blocks new runs until restart | P2 | `hooks/useEvalRun.ts:43-48` |
| [#1032](https://github.com/dipjyotimetia/restura/issues/1032) | Reads from model endpoints are unbounded (fix together with #929) | P2 · security | `shared/protocol/ai/ai-complete.ts:24-32` |
| [#1033](https://github.com/dipjyotimetia/restura/issues/1033) | The localhost carve-out for local providers is too broad and inconsistent | P1 · security | `electron/main/security/safe-connect.ts:69-88` |
| [#1034](https://github.com/dipjyotimetia/restura/issues/1034) | The telemetry endpoint is validated as a string only | P2 · security | `shared/agent-lab/telemetry-config.ts:12-37` |
| [#1035](https://github.com/dipjyotimetia/restura/issues/1035) | Large tool outputs exceed IPC limits | P2 | `electron/main/ipc/validators/ai.ts:18` |
| [#1036](https://github.com/dipjyotimetia/restura/issues/1036)–[#1041](https://github.com/dipjyotimetia/restura/issues/1041) | CLI preflight, Ctrl-C and script parity; judge anchors editor; interrupted-run status; tool-name collisions | P3 | see issues |

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| Q1 | Deliverable: this audit, GitHub issues, and a roadmap update. Fixes happen in separate worktree sessions | One topic per branch |
| Q2 | Ideas must fit the API-client × LLM wedge; the rest go in a "parked" list | Generic eval workbenches are a crowded market |
| Q3 | AI Lab stays **Electron-only** | Keeping provider keys and SSRF handling out of the Worker; local models are desktop-only anyway |
| Q4 | Planning horizon is 6–12 months; new architecture is allowed | — |
| Q5 | Security bugs and misleading statuses are fixed before new features; polish can ship alongside | — |
| Q6 | Suggestions apply to all personas, with role-specific notes | — |
| Q8 | Sandbox: build a QuickJS provider now; Docker/Podman is a follow-on | Reuses the hardened sandbox and makes the capability flag true |
| Q9 | `a2a` becomes a tool source only; no A2A protocol tab | — |
| Q10 | Provider order: Azure → Bedrock → Gemini, each on desktop and CLI | Enterprise API engineers first; SigV4 signing already exists |
| Q11 | Add `restura eval run` with judges and provider parity; this reverses "the CLI refuses judges" and gets an ADR | Regression gating in CI |
| Q12 | Move Arena onto RunEngine before adding Arena features | It gets cancellation, envelopes and reports |
| Q13 | One Agent Lab ADR, plus a separate ADR for the CLI judge decision | — |
| Q14 | Secret check depends on provider kind: on for cloud, off for local, with a visible override | #1028 |
| Q15 | Strip environment values, scrub paths and bodies, and show a redaction diff before saving | #1029 |
| Q16 | Local providers may reach loopback and RFC 1918 addresses, whether given as literals or hostnames; all link-local addresses are blocked; independent of global toggles | #1033 |
| Q17 | The server's `destructiveHint` overrides the manifest; `isCiSafePolicy` is enforced | #1026, #1027 |
| Q18 | Per-call cap = `min(remaining, model cap, 32768)`; no schema bump | #1021 |
| Q19 | Move the pricing table to `shared/`; preflight refuses unpriced models | #1022 |
| Q20 | Arena errors are excluded from Elo; new `partial` status; matches already played are kept | #1023 |
| Q21 | Per-eval pass threshold, default 100% | #1024 |
| Q22 | Validate each record separately and quarantine bad ones; cap eval reports; failed saves can be dismissed | #1030, #1025, #1031 |
| Q23 | One shared response-size cap, which also closes #929 | #1032 |
| Q24 | Tool-call evals reuse the agent tool sources, with a JSON-schema fallback | #1019 |
| Q25 | Add a `systemone` provider kind for decision models (Clef first, then Jev) | Open weights and local-first |
| Q26 | Add a `decision` scorer now; the approval gate is a follow-on | Calibrated and cheap per case |
| Q27 | Headline bets 1, 3 and 4; follow-ons 2, 5 and 6 | See §5 |

## 4. Gaps → work (filed)

| Issue | Work |
|---|---|
| [#1046](https://github.com/dipjyotimetia/restura/issues/1046) | Move Arena onto RunEngine |
| [#1047](https://github.com/dipjyotimetia/restura/issues/1047) | ADR: Agent Lab (suites, runtime, telemetry, Arena) |
| [#1048](https://github.com/dipjyotimetia/restura/issues/1048) | ADR: CLI judges and dataset evals |
| [#1045](https://github.com/dipjyotimetia/restura/issues/1045) | `restura eval run` |
| [#1044](https://github.com/dipjyotimetia/restura/issues/1044) | Azure OpenAI → Bedrock → Gemini transports |
| [#1042](https://github.com/dipjyotimetia/restura/issues/1042) | QuickJS sandbox provider |
| [#1043](https://github.com/dipjyotimetia/restura/issues/1043) | `a2a` tool source |

## 5. Forward-looking work

### Decision models

Cloudflare **Clef** (released 2026-10-01; open Apache-2.0 weights; 27B, plus the 9B Clef-flash; available on Workers AI) and TypeSafe AI **Jev** (early access since 2026-09-15; hosted only) are *decision models*. They take a state plus typed questions and return a calibrated probability for each allowed answer in a single pass, without free-form text. Clef's API is compatible with Jev/SystemOne. Latency claims (about 39 ms for Clef-flash, about 209 ms for Clef, about 524 ms for Jev) are Cloudflare's own benchmarks.

- [#1049](https://github.com/dipjyotimetia/restura/issues/1049): a `systemone` provider kind, plus a typed-questions mode in the Playground
- [#1050](https://github.com/dipjyotimetia/restura/issues/1050): a `decision` scorer (typed questions about each response, pass/fail by probability threshold)

### Bets for the next 6–12 months

Headline:
- [#1051](https://github.com/dipjyotimetia/restura/issues/1051) **Live traffic → regression datasets**: record and replay for LLM-backed endpoints
- [#1052](https://github.com/dipjyotimetia/restura/issues/1052) **MCP server conformance and eval suite**
- [#1053](https://github.com/dipjyotimetia/restura/issues/1053) **Model-drift watch**: scheduled evals that alert on regressions

Follow-on:
- [#1054](https://github.com/dipjyotimetia/restura/issues/1054) Contract-driven API explorer agent
- [#1055](https://github.com/dipjyotimetia/restura/issues/1055) Docker/Podman sandbox provider
- [#1056](https://github.com/dipjyotimetia/restura/issues/1056) Decision-model tool-approval gate (needs an ADR and a security review)

### Parked (not differentiated)

DSPy/GEPA-style prompt optimisation · voice/realtime model evals · A2A protocol tab · web AI Lab.

## Sources

- Cloudflare: [Clef on Workers AI](https://developers.cloudflare.com/workers-ai/models/clef/) · [changelog 2026-10-01](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/) · [Hugging Face](https://huggingface.co/Cloudflare/clef) · [InfoQ](https://www.infoq.com/news/2026/10/clef-decision-models/)
- TypeSafe AI: [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) · [docs](https://docs.typesafe.ai/introduction)
