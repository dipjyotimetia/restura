# AI Lab Unified Run Engine Design

## Status

Approved on 2026-07-13 for PR #480. This specification replaces the narrower patch-by-patch repair approach with a unified run-lifecycle design shared by prompt evaluations and agent suites.

## Objective

Make AI Lab runs production-safe and observable across the Electron renderer and main process while closing every Critical, Important, and Minor finding from the fresh PR #480 review. The result must enforce cancellation and resource limits against real upstream work, grade each task with its own context, represent provider capabilities and costs honestly, execute saved requests with normal Restura scopes, persist full reports, and retain current security boundaries.

## Constraints

- AI Lab remains Electron-only. Capability rows must not imply web or self-host support.
- The shared agent runtime remains backend-agnostic and must not import renderer, Electron, Zustand, or Node APIs.
- Existing shared SSRF, header, auth, redirect, secret-handle, and request-execution boundaries remain authoritative.
- Renderer code never resolves secret-handle plaintext.
- MCP and sandbox runtime capability rows remain disabled until concrete implementations ship.
- Existing prompt evaluation behavior and stored reports migrate without data loss.
- Unsupported or unverifiable capabilities, prices, token usage, judge quorum, and suite semantics fail closed before or at the narrowest safe boundary.

## Architecture

### Unified run lifecycle

Add a focused `src/features/ai-lab/run-engine/` module that owns lifecycle rather than scoring or model semantics. A run job contains:

- a collision-resistant job ID;
- kind: `eval` or `agent-suite`;
- status: queued, running, cancelling, passed, failed, error, or cancelled;
- start and finish timestamps;
- progress and structured failure records;
- an `AbortController` owned by the engine;
- a typed report produced by the selected executor.

The engine accepts an executor callback with `{ jobId, signal, reportProgress }`. Existing prompt evaluation and agent-suite logic remain separate executors. This avoids merging two scoring systems while giving both the same cancellation, persistence, navigation, and late-result rules.

Once cancellation begins, the engine ignores late success and persists a cancelled result. It waits only for operations that honor the signal; IPC cancellation ensures upstream sockets are actually aborted instead of merely racing a renderer promise.

### Cancellable model operations

Every non-streaming AI Lab completion receives a renderer-generated `operationId`. The Electron main process stores active operations by ID with the owning `webContents.id`, abort controller, and queue state.

Add a validated `ai-lab:complete-cancel` IPC method and preload/type declarations. Cancellation succeeds idempotently for completed operations, rejects cross-renderer ownership, aborts queued or running calls, and releases semaphore capacity exactly once. Renderer `completeLlm` accepts an `AbortSignal`, registers a one-shot abort listener, invokes cancellation, and removes the listener in `finally`.

The existing streaming cancellation path remains unchanged. Other AI Lab call sites may adopt the cancellable completion API without changing their model request shapes.

### Cancellable saved-request operations

Extend `RequestExecutorOptions` and the renderer transport interfaces with an optional `AbortSignal`. Forward it through normal HTTP proxy execution to the existing shared/Electron fetch boundary. Script phases and nested `pm.sendRequest` execution must observe cancellation where their host interfaces support it; cancellation is checked between phases even when a synchronous script cannot be interrupted mid-instruction.

Agent tools receive the runner signal and pass it to `executeRequest`. An approved mutating request therefore cannot continue silently after its agent run is cancelled or times out.

### Saved-request context and redaction

Resolve the owning collection for each tool source. At execution time use the same normal-send inputs:

- active environment plus workspace globals;
- owning collection variables;
- inherited collection/folder authentication;
- effective global/per-request settings;
- script collection-variable mutation write-back.

Descriptions contain method, request name, and a sanitized URL. Sanitization removes userinfo, fragments, and query values while preserving parameter names. Invalid or templated URLs use a conservative textual redactor so secrets are not exposed before variable resolution.

### Honest pricing and capabilities

Desktop generation responses include `costUSD` only when pricing is known for that exact model. Local Ollama may be explicitly classified as zero-cost local execution; arbitrary gateways and models with unknown pricing remain undefined. A configured `maxCostUSD` then activates the shared runner's existing fail-closed unknown-cost behavior.

Replace provider-wide desktop capability claims with a per-model resolver. Discovery metadata is converted into persisted capability records. Unknown models default to text input/output, structured output off, tool calling off, parallel tools off, reasoning off, and continuation off. Known first-party model-family metadata may enable supported features. A user may persist an explicit capability override, but the UI and exported suite/report label it as user asserted.

### Token and output limits

Clarify the agent limit as a run-wide total token budget. Before each model call, calculate remaining tokens and pass only the remaining allowance as `maxOutputTokens`. If the remaining allowance is zero, stop before the call. When a hard token budget is configured, missing provider usage is an enforcement error. After each response, accumulate input plus output usage and reject overshoot before executing any returned tools.

Output-byte accounting continues to include normalized model output, opaque provider state, and tool output.

### Task-aware grading

Introduce a grading context containing task ID, task input, optional reference, agent output, trace, latency, usage, and cost. `AgentSuiteRunner` passes this context to each grader.

Reference-aware deterministic graders resolve expectations from the current task. Suite-global literal graders remain supported where semantically appropriate. Judge prompts contain task input, reference when present, candidate output, rubric, labels, and response schema.

Judge panels execute with settled results. Successful votes are preserved; failures are recorded by judge model. Aggregation requires a configured quorum, defaulting to a strict majority of the panel. Insufficient quorum fails that grader with explicit detail without deleting other grader results.

### Calibration validation

`AgentSuiteSchema.superRefine` rejects calibrated judges unless:

- at least two anchors exist;
- every anchor label and passing label belongs to `labels`;
- anchors cover at least one passing and one non-passing label;
- anchor scores span a meaningful interval of at least 0.5;
- judge model IDs are unique within the panel;
- quorum is between 1 and the panel size.

Runtime calibration accuracy and mean-absolute-error checks remain as defense in depth.

### Reports and migration

The run engine persists typed report envelopes containing either an existing eval report or an agent-suite report. Existing eval-run records remain readable and are migrated lazily into the envelope view rather than rewritten destructively.

The Reports surface adds an agent-suite report branch showing:

- suite status and confidence interval;
- reliability by agent/task;
- task input and reference;
- grader scores and details;
- per-judge failures and quorum;
- typed traces and resource usage;
- JSON export.

Agent Workbench navigates to the persisted report after completion and provides a Cancel action while the job is active.

### CLI behavior

Keep headless support intentionally narrow: OpenAI Responses, environment credentials, no tools, no judge adapters, and no base URL overrides. Extract preflight and command-result mapping into testable functions. Direct tests cover:

- schema failure;
- unsupported provider, secret handle, tool source, judge, and base URL rejection;
- report file output;
- exit codes 0, 1, and 2;
- no listener or external network requirement.

### Documentation

Update ADR 0020 to say that OpenAI Responses uses stateless encrypted reasoning/tool replay with `store: false`; server-side continuation remains disabled. Capability and OpenWiki documentation describe conservative per-model negotiation, real cancellation, task-aware grading, report persistence, and the continued absence of concrete MCP/sandbox runtimes.

## Error Handling

- Cancellation takes precedence over late provider or tool success.
- Cross-renderer cancel attempts fail validation and do not disclose operation state.
- Unknown cost fails only when a hard cost budget is configured.
- Missing usage fails only when a hard token budget is configured.
- One judge failure does not erase successful votes; insufficient quorum fails only that grader.
- Invalid imported suites fail before tool resolution or paid model calls.
- Report persistence failure leaves the completed in-memory report available and surfaces an actionable error.
- Collection-variable mutations are applied only when request execution completes successfully.

## Verification Strategy

Implementation is test-first. Each changed behavior must have a regression test that fails before production code changes.

Required focused coverage:

- real renderer-to-main completion cancellation, including queued calls and sender ownership;
- agent wall timeout aborting the desktop provider and an approved saved HTTP tool;
- unknown desktop pricing and missing token usage failing configured budgets;
- remaining-token allowance across multiple model/tool turns;
- conservative per-model capability negotiation and explicit overrides;
- URL redaction and active environment/global/collection variable resolution;
- inherited auth and collection-variable mutation write-back;
- task-specific references across multiple tasks;
- partial judge failure, quorum, and calibration schema rules;
- run-engine late-result cancellation and report persistence/navigation;
- direct CLI preflight, output, and exit-code tests;
- existing OpenAI and Anthropic multi-round tool wire tests.

Final gates:

- focused Vitest suites after every red/green cycle;
- `npm run validate` outside the sandbox so localhost integration tests can bind;
- `npm run build`;
- `npm run electron:compile`;
- `npm --prefix cli run build`;
- live browser smoke test when a browser-control runtime is available;
- fresh read-only review of the complete PR diff before push.

## Rollout and Compatibility

No server migration or protocol-version negotiation is required. New persisted run/report fields use versioned Zod validation and additive migration. Existing provider configs without capability metadata receive conservative defaults. Existing suites without quorum use the derived majority. Existing uncalibrated judge suites remain valid. Invalid calibrated suites are surfaced for repair rather than silently altered.
