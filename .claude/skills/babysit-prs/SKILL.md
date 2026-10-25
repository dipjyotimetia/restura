---
name: babysit-prs
description: "Time-based PR-care loop body: check my open PRs, fix failing CI, address bot/human review comments, keep the merge lane moving. Use when asked to 'watch/babysit/look after my PRs', 'why is CI red on my PR', or driven by /loop 15m or PR-activity subscriptions."
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
   lease. Prefer not to loop on this: enable auto-merge on green PRs
   (`gh pr merge <n> --auto --squash`); the merge lane (`merge-lane.yml`)
   updates them onto `main` one at a time and CI re-runs on the combined
   result. `--admin` bypasses required checks and is for emergencies only.
   A PR labelled `merge-lane:conflict` (DIRTY) is the exception: rebase it
   locally in a worktree (`npm run worktree:setup`, rebase onto
   `origin/main`, resolve), run `npm run integration-check -- <branch>`,
   then `git push --force-with-lease` with hooks enabled (no `--no-verify`).
   Leave `merge-lane:hold` PRs alone.
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

## After each merge round

When one or more watched PRs merged, run
`npm run integration-check -- <remaining branches>` (add `--e2e` if transport/UI is touched) once instead of rebasing
and force-pushing each PR serially. Fix only the PRs it reports as conflicting
or red on the combined result. Any file overlap it reports between PRs is a
planning bug: tell the user and propose merging those PRs.

## Loop discipline

- One consolidated status line per changed PR, e.g.
  `#456: CI green after lint fix, 1 review thread resolved`. No narration for
  untouched PRs; if nothing changed anywhere, end the turn with no message.
- Never push fixes that touch security boundaries (`shared/protocol/`,
  guards, IPC validators, secret stores) without flagging the diff first.
- The loop is finished only when every watched PR is merged or closed — say
  so explicitly when that state is reached so the outer /loop can be stopped.
