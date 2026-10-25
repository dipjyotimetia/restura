---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base; defaults to the merge-base with origin/main) along three axes: Correctness (bugs, edge cases, error paths, races, and Restura seam breaks across renderer/Worker/Electron/CLI), Standards (does the code follow this repo's documented coding standards?) and Spec (does it match the originating issue/spec?). Runs the axes in parallel sub-agents and reports them side by side. Non-interactive safe. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\". This is the canonical code review for this repo (prefer it over generic plugin code-review skills); /ship-check calls it as the fresh-context review pass."
---

<!-- Forked from mattpocock/skills `code-review` (Standards + Spec axes) and extended
     for Restura with a Correctness axis and non-interactive defaults. Maintained
     locally — not tracked in skills-lock.json. -->

Three-axis review of the diff between `HEAD` and a fixed point:

- **Correctness**: does the code actually work — including at the seams where Restura's harnesses meet?
- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?

Each axis runs as a **parallel sub-agent** so they don't pollute each other's context, then this skill aggregates their findings.

**Never ask the user questions.** This skill runs inside `/ship-check`, `/batch-ship` and CI (`claude-skill-review` in `.github/workflows/claude-code-review.yml`), where nobody is there to answer. Every decision below has a default; take it and say which default you took in the report.

Issues live in GitHub Issues; how to read them (the `gh` workflow, labels) is in `docs/agents/issue-tracker.md`. Domain terms and ADRs are in `CONTEXT.md` and `docs/adr/` (see `docs/agents/domain.md`).

## Process

### 1. Pin the fixed point

Use whatever fixed point the caller supplied (a commit SHA, branch name, tag, `main`, `HEAD~5`, a PR's base, etc.). If none was given, default to `git merge-base HEAD origin/main`, falling back to `main` when `origin/main` doesn't resolve. Do not ask.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`. If the caller asked to include uncommitted work, also capture `git diff HEAD`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here (report it and stop), not inside three parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages or PR body (`#123`, `Closes #45`), fetched with `gh issue view <n>` per `docs/agents/issue-tracker.md`.
2. A path the caller passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, **skip the Spec axis** and report "no spec available". Never ask where the spec is.

### 3. Identify the standards sources

Search the repo for every file that documents how code should be written. For Restura that is at least `CLAUDE.md` / `AGENTS.md` (architecture invariants), `docs/agents/architecture.md`, the relevant `docs/adr/*`, and the `restura-feature-dev` skill references when the diff touches a feature or protocol. When `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists, it must be on the list.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn the sub-agents in parallel

Issue all sub-agent calls together (one message, multiple Agent/Task calls), in the foreground, and aggregate the reports they return. Each sub-agent only knows its prompt — paste everything it needs.

**Correctness sub-agent prompt** should include:

- The full diff command and commit list (and any overlap matrix / per-branch diffs the caller supplied, e.g. from `npm run integration-check`).
- The brief: "You are reviewing for correctness only — not style, not spec. Read the changed code AND its callers/callees, not just the hunks. Find: (a) bugs and logic errors; (b) unhandled edge cases (empty/undefined, `noUncheckedIndexedAccess` holes, large inputs, unicode, timeouts, cancellation); (c) error paths that swallow, mis-report or leak (secrets, `SecretRef` plaintext); (d) races and ordering bugs (async state, listeners not disposed, stale closures); (e) **Restura seams** — for every changed function, type or wire format, grep every consumer across the renderer (`src/`), the Worker (`worker/`), Electron main (`electron/main/handlers/`), the CLI (`cli/src/runner/executors/*`), `shared/protocol/`, and mocks (`e2e/mocks/`, `echo/`, `echo-local/`) and say whether each still behaves the same or fails explicitly (web/self-host/desktop/CLI parity is the #1 bug class); (f) the same transform duplicated in more than one place or branch, and behaviour that only breaks when branches/files are combined. For each finding give severity (critical/high/medium/low), `file:line`, and a concrete failure scenario (input → wrong output/crash). Mark each finding **blocking** or **non-blocking**. Do not report anything you could not tie to a concrete scenario. Under 500 words."

**Standards sub-agent prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the reports under `## Correctness`, `## Standards` and `## Spec` headings, in that order, verbatim or lightly cleaned. Do **not** merge or rerank findings across axes, because the axes are deliberately separate (see _Why separate axes_). Within Correctness, keep the sub-agent's severity order and its blocking/non-blocking marks.

End with a one-line summary: total findings per axis, the number of **blocking** Correctness findings, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

## Why separate axes

A change can pass one axis and fail another:

- Code that follows every standard and matches the spec but crashes on an empty response, or works on web and silently breaks on desktop → **Standards + Spec pass, Correctness fail.**
- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking another.
