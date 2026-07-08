---
description: 'Goal-based loop: iterate on the current branch until the full validate gate passes, with a hard turn cap. Deterministic exit criteria — no "looks good to me" early stops.'
argument-hint: '[max attempts, default 5] [optional gate override, e.g. "test:run only"]'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Task
---

You are running a fix-until-green loop on the current branch. The exit
criterion is deterministic: **`npm run validate` exits 0** (type-check:all +
lint + format:check + codegen freshness + tests + CLI tests). Do not stop
because the work "looks done" — stop when the gate is green or the attempt cap
is hit.

Arguments: `$ARGUMENTS`. First number = attempt cap (default **5**). If a gate
override is given, use that command as the exit criterion instead.

## Loop

Repeat up to the attempt cap:

1. Run the gate. If green: **stop — report success** with the passing output
   summary and a list of the commits/edits made.
2. If red: parse failures to `file:line`. Fix the **first root cause**, not
   every symptom — one coherent fix per iteration keeps the diff reviewable.
   - type-check failures in worker/electron/cli: remember plain `type-check`
     is renderer-only; reproduce with the failing project's tsconfig.
   - codegen failures: regenerate (`gen:opencollection-types` /
     `capabilities:matrix`) — never hand-edit generated files.
   - format failures: `npm run format`.
   - test failures: read the test to decide whether the code or the test is
     wrong before touching either.
3. Re-run **only the failed gate** to confirm the fix, then loop back to the
   full gate.

## Guardrails

- If the same gate fails with the same error two iterations in a row, your
  fix isn't taking — stop and report the diagnosis instead of burning the
  remaining attempts.
- If a fix would touch a security boundary (`shared/protocol/`, guards, IPC
  validators, secret stores), pause the loop and flag it — that is not a
  mechanical fix.
- On cap exhaustion: report NOT GREEN with the remaining failures at
  `file:line`, what was tried, and the recommended next step.

Tip: for an evaluator-enforced version of this loop, invoke via
`/goal make npm run validate pass on this branch, stop after 5 tries`.
