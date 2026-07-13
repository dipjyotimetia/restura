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

## Scope notes

- Report persistence is additive in `useAiLabStore` version 4; the separate legacy eval-run store is intentionally retained.
- Agent report envelopes include a validated suite snapshot so task input/reference remain interpretable even if the saved suite later changes.
- Full repository validation is left to the controlling session; this task ran the brief's focused suites plus renderer type-check/lint/diff checks.
