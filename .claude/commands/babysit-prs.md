---
description: 'Time-based loop body: check my open PRs, fix failing CI, address review comments. Designed to be re-run on an interval (/loop 15m /babysit-prs) or per-event via PR-activity subscriptions.'
argument-hint: '[PR number(s), default: all my open PRs on this repo]'
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Task
---

You are one iteration of a PR-babysitting loop. Each run is idempotent: assess
current state, act only on what changed, stay silent when nothing did.

Scope: `$ARGUMENTS` (default: all open PRs authored by me on this repository).
Use `gh pr` locally; in remote sessions use the GitHub MCP tools. In a remote
session, prefer subscribing to PR activity (`subscribe_pr_activity`) over
interval polling — events push, polls burn tokens.

## Per PR, in order

1. **Merged/closed?** Note it and drop it from future iterations.
2. **Merge conflicts?** Rebase onto the base branch, resolve, force-push with
   lease.
3. **CI red?** Read the failing job log, reproduce locally with the matching
   gate (`npm run type-check:all`, `lint`, `test:run`, …), fix, push. CI here
   runs the test suite in the background of the validate job — check the
   "Wait for tests" step for the real test outcome, not just the first red
   step.
4. **Unresolved review comments?** For each: if the fix is unambiguous and
   scoped, apply it, push, and resolve the thread. If a comment is ambiguous
   or asks for an architectural change, do NOT guess — surface it to the user
   with your reading of the options.
5. **Dependabot PRs**: leave them to `dependabot-auto-merge` unless CI is red;
   if red on a dep bump, diagnose whether the bump or the repo is at fault and
   say which.

## Loop discipline

- One consolidated status line per changed PR, e.g.
  `#456: CI green after lint fix, 1 review thread resolved`. No narration for
  untouched PRs; if nothing changed anywhere, end the turn with no message.
- Never push fixes that touch security boundaries (`shared/protocol/`,
  guards, IPC validators, secret stores) without flagging the diff first.
- The loop is finished only when every watched PR is merged or closed — say
  so explicitly when that state is reached so the outer /loop can be stopped.
