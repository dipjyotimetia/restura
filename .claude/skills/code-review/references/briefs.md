# Sub-agent briefs for the `code-review` skill

The parent passes each sub-agent a short **header** (below) and the name of the brief to run. The sub-agent reads this file and `REVIEW.md` itself, so the parent never pastes them. Every brief ends with the shared **output contract**.

## Header the parent supplies

```
Brief: <correctness | standards | spec | verify | quick>   (from .claude/skills/code-review/references/briefs.md)
Fixed point: <ref>        Depth: <quick | standard | deep>        Round: <n>
Diff: <the exact git diff command, with the REVIEW.md excludes>
Commits: <git log --oneline output, or "uncommitted">
Spec: <path or fetched text, or "none">                      (spec brief only)
Standards: <list of standards files>                         (standards / quick only)
Prior findings (do not repeat): <file:line — one line each, or "none">
Extra context: <overlap matrix, per-branch diffs, stacked-PR note, or "none">
```

Read `REVIEW.md` first (what failure looks like per area, evidence rule, caps). Run the diff command yourself; do not ask for the diff. Read the changed files, not only the hunks.

## correctness

You review for correctness only, not style, not spec. Find:

1. **Bugs and logic errors** in the changed code.
2. **Unhandled edge cases**: empty/undefined, `noUncheckedIndexedAccess` holes, large inputs, unicode, timeouts, cancellation.
3. **Error paths** that swallow, mis-report or leak (secrets, `SecretRef` plaintext in logs/errors/exports).
4. **Races and ordering**: async state, listeners not disposed, stale closures, double-dispose.
5. **Restura seams** (the #1 bug class). For every changed function, type or wire format, grep every consumer across the renderer (`src/`), the Worker (`worker/`), Electron main (`electron/main/handlers/`), the CLI (`cli/src/runner/executors/*`), `shared/protocol/` and the mocks (`e2e/mocks/`, `echo/`, `echo-local/`). Say for each whether it still behaves the same or fails explicitly. Silent divergence is Important.
6. **Combination bugs**: the same transform duplicated in more than one place or branch, and behaviour that only breaks when branches or files are combined (use the overlap matrix if supplied).

For a bug fix, also ask whether the change fixes the root cause or a symptom.

Depth rules: at **deep** the parent runs two of you; the second one reads this brief with emphasis on items 5–6 (consumers and combinations) and the first on items 1–4. At **quick** fold this brief into the `quick` brief below.

Severity filter: style, diagnostics, naming and cleanup are not correctness findings; drop them (the Standards axis owns them). Do not report anything you cannot tie to a concrete scenario.

## standards

Report, per file/hunk where relevant:

1. every place the diff violates a **documented standard** in the Standards list (cite file + rule), and
2. any smell from `.claude/skills/code-review/references/smells.md` (read it; name the smell, quote the hunk).

Documented-standard breaches may be Important when they break an architecture invariant (`CLAUDE.md`); smells are always Nit-level judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces (see `REVIEW.md`). Respect the Nit cap: group by class.

## spec

Compare the diff with the spec. Report:

1. requirements the spec asked for that are **missing or partial**;
2. behaviour in the diff that **was not asked for** (scope creep);
3. requirements that look implemented but where the implementation looks **wrong**.

Quote the spec line for each finding. If the header says this is one layer of a stacked PR, do not report later layers' work as missing.

## quick

One agent, small diff. Run the `correctness` brief, then the `standards` brief, and the `spec` brief only when a spec is supplied. Report each under its own heading (`## Correctness`, `## Standards`, `## Spec`), in that order, with the output contract below. Do not merge or rerank across headings.

## verify

You are a **verifier**, not a reviewer. The header lists candidate Important findings, each with `file:line`, mechanism and scenario. For each one, open the cited file and its direct callers/callees and decide independently whether the bug is real as described. Do not hunt for new bugs. Answer per finding, nothing else:

```
<n>. CONFIRMED | REJECTED | DOWNGRADE→Nit | DOWNGRADE→Pre-existing — <one sentence of evidence with file:line>
```

`REJECTED` means the scenario cannot happen as stated (guarded elsewhere, type makes it impossible, wrong line). `DOWNGRADE→Pre-existing` means real, but present before this change. Prefer `REJECTED` to a vague confirmation: a false alarm costs an author a whole fix round.

## Output contract (all briefs)

- One line per finding, most severe first:
  `- **<Important (blocking) | Nit | Pre-existing>** \`path:line\` — <mechanism>; <scenario: input → outcome>.` For bug classes, one line listing every site.
- Findings only; no preamble, no restating the diff, no praise.
- Never repeat a prior finding from the header; if it is still unfixed, write one line `Still open: <file:line>` instead.
- Nothing found: write exactly `Nothing to fix.` under the heading.
