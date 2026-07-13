# Task 7 report: unified run cancellation and reports

## Outcome

- Prompt evals and agent suites now launch through `RunEngine`.
- Cancellation signals reach eval retries, model and judge calls, extracted HTTP execution, agent trials, tools, and judge panels. `RunEngine` rejects late success after cancellation.
- New prompt eval and agent-suite reports persist as additive discriminated envelopes. Legacy eval records remain unchanged and are adapted only when Reports reads them.
- Agent Workbench exposes Cancel, reports progress, persists the complete report plus suite/task snapshot, and opens Reports after successful persistence.
- Reports renders agent summary/confidence, per-task reliability and input/reference, trial grades, judge quorum/failures, traces, usage/cost, and JSON export while preserving the existing eval report UI.
- A persistence exception is shown to the user after retaining the completed envelope in component memory.

## RED evidence

Command:

```text
npx vitest run src/features/ai-lab/run-engine/__tests__/reportEnvelope.test.ts src/features/ai-lab/components/__tests__/AgentWorkbench.test.tsx src/features/ai-lab/store/__tests__/useAiLabStore.test.ts
```

Observed failures:

- `reportEnvelope` module did not exist.
- `saveRunReport` was absent.
- `runReports` migration default was absent.
- Agent completion did not persist/open Reports and Cancel was absent.

Additional RED runs proved:

- `useEvalRun` did not persist envelopes.
- `completeWithRetry` retried after abort.
- eval model and HTTP operations did not receive the run signal.
- Reports ignored persisted agent-suite reports.

## GREEN evidence

Focused command:

```text
npx vitest run src/features/ai-lab/run-engine src/features/ai-lab/components/__tests__/AgentWorkbench.test.tsx src/features/ai-lab/components/__tests__/ReportView.test.tsx src/features/ai-lab/components/__tests__/judgeStats.test.ts src/features/ai-lab/store/__tests__ src/features/ai-lab/hooks/__tests__/useEvalRun.test.ts src/features/ai-lab/lib/__tests__/evalRunner.test.ts src/features/ai-lab/lib/__tests__/agentRuntime.test.ts src/lib/shared/__tests__/completeRetry.test.ts
```

Result: 14 test files passed, 79 tests passed.

Additional gates:

```text
npm run type-check
npx eslint <all Task 7 changed TypeScript files>
git diff --check
```

Result: all exited 0 with no reported errors or warnings.

## Blocking-review follow-up

Review identified lifecycle, durable-persistence, validation, report-completeness,
sanitization/retention, and navigation-count gaps. The follow-up adds:

- a module-scoped agent run service whose state survives tab unmount/remount,
  rejects concurrent starts, preserves Cancel, suppresses stale owner side
  effects, and retains the latest sanitized completion in memory;
- a dedicated awaited strict Dexie report repository, surfaced write errors,
  live fallback viewing/export, and explicit retry;
- concrete Zod schemas for eval and agent-suite payloads plus per-entry suite and
  report quarantine with warnings and a persisted quarantine count;
- complete agent outcome/reliability/trial/grader/judge/trace rendering with
  fully-known, partially-known, and unknown resource accounting;
- recursive secret/header/query/body redaction, explicit content truncation,
  a 2 MiB per-agent-report ceiling, and deterministic 20-report/20 MiB agent
  retention; JSON export consumes only sanitized envelopes;
- agent report inclusion in Reports readiness/counting and empty-state logic.

### Follow-up RED evidence

New tests initially failed because active job state was component-local,
durable saves were not awaited, malformed report payloads were accepted,
secrets and oversized content were unbounded, agent-only reports were omitted
from navigation counts, and the UI treated missing cost as zero.

### Follow-up GREEN evidence

```text
npx vitest run src/features/ai-lab/run-engine src/features/ai-lab/store/__tests__ src/features/ai-lab/components/__tests__/AgentWorkbench.test.tsx src/features/ai-lab/components/__tests__/ReportView.test.tsx src/features/ai-lab/components/__tests__/AiLabWorkspace.test.tsx src/features/ai-lab/hooks/__tests__/useEvalRun.test.ts src/features/ai-lab/lib/__tests__/agentRuntime.test.ts
```

Result: 13 files passed, 71 tests passed.

`npm run type-check:all` passed across renderer, Electron, HTTP, Worker, echo,
CLI, Chrome extension, and VS Code extension projects. `npm run lint` completed
without errors; the initially reported import-order warnings were fixed.
Changed files pass focused Prettier and `git diff --check`. Repository-wide
`npm run format:check` remains blocked only by the eight pre-existing ignored
`.superpowers/sdd/task-{1..8}-brief.md` files; this follow-up does not rewrite
task briefs.

## Scope notes

- Report persistence is additive in `useAiLabStore` version 4; the separate legacy eval-run store is intentionally retained.
- Agent report envelopes include a validated suite snapshot so task input/reference remain interpretable even if the saved suite later changes.
- Full repository validation is left to the controlling session; this task ran the brief's focused suites plus renderer type-check/lint/diff checks.

## Re-review blocker fix

- Report envelopes now have one awaited repository for save, hydration, deletion,
  and retention. The main Zustand payload no longer writes a divergent report
  copy; legacy reports are merged into the canonical repository during hydration.
- Prompt eval completion uses the same awaited repository, retains a live fallback
  after failure, and exposes an explicit retry action.
- Secret-key matching is exact after key normalization, preserving resource fields
  such as `inputTokens`, `outputTokens`, and `maxTokens`; a real report-schema
  round-trip test protects the persistence boundary.
- An agent completion after owner unmount is marked pending whenever its id differs
  from the confirmed persisted id, so remount exposes retry instead of presenting
  an unsaved completion as durable.
- Judge scores record attempted, usage-known, and cost-known calls across panel and
  calibration invocations. Reports also count failed model calls, preventing a
  failed or multi-call panel from being labelled fully known.

### Re-review fix gates

```text
npx vitest run src/features/ai-lab/run-engine src/features/ai-lab/store/__tests__ src/features/ai-lab/components/__tests__/AgentWorkbench.test.tsx src/features/ai-lab/components/__tests__/ReportView.test.tsx src/features/ai-lab/components/__tests__/AiLabWorkspace.test.tsx src/features/ai-lab/hooks/__tests__/useEvalRun.test.ts src/features/ai-lab/lib/__tests__/agentRuntime.test.ts
```

Result: 13 files passed, 76 tests passed.

`npm run type-check:all`, focused ESLint, focused Prettier, and
`git diff --check -- . ':!cli/**'` passed. CLI source changes owned by Task 8
were neither modified nor included in this fix.

## Retry-retention follow-up

Starting a new eval or agent suite now refuses to proceed while a completed
report is still awaiting canonical persistence. This keeps the only live retry
handle intact instead of silently discarding an unsaved report. Regression
tests cover both prompt-eval save failure and agent completion after workbench
unmount.

Focused Task 7 verification passed 13 files / 78 tests, and
`npm run type-check:all`, focused ESLint/Prettier, and `git diff --check` passed.
