# Build eval: does the main agent loop ship correct, parity-complete fixes?

`evals/harness/` measures whether the **reviewer** catches seam bugs. This suite measures the
other half: given a bug report, does the **main agent loop** (CLAUDE.md, the
`restura-feature-dev` / `tdd` skills, hooks) produce a fix that is correct on every harness
(web Worker, self-host, Electron, CLI) it touches?

It follows Anthropic's agent-eval guidance, SWE-bench style:

- each task is a real fix PR from this repo; the agent gets the bug as an issue and the repo as
  it was just before the fix;
- the **outcome state** is graded by code, never the agent's claims: the fix PR's own tests
  (hidden from the agent) are copied in after the agent finishes, then `failToPass` (must now
  pass) and `passToPass` (must still pass) commands run;
- a **reference solution** (the fix commit) proves every task is solvable and its graders work;
- the agent works in an **isolated, history-free repo**, so the answer is unreachable;
- **several trials** per task, reported as pass@1 and pass^n, with a Wilson 95% CI on totals.

```bash
node scripts/build-eval.mjs --dry-run                     # validator: no model calls (minutes per task)
node scripts/build-eval.mjs --dry-run --case cli-graphql-get
node scripts/build-eval.mjs --split train --runs 2        # REAL RUN: costs money (see below)
node scripts/build-eval.mjs --split test --runs 3 --config slim-claude-md --harness-ref my-branch
```

Options: `--case <id>` (repeatable), `--split train|test|all` (default all), `--runs N`
(default 2; a dry run always does 1), `--harness-ref <ref>` (default `HEAD`; the harness under
test, see below), `--config <label>` (names the result files), `--model <model>`,
`--max-budget-usd <n>` (per agent run, default 15), `--out <dir>` (default
`.claude/metrics/evals/build/`), `--dry-run`. There is no npm script on purpose.

## Cost warning

A real run is one full `claude -p` agent session per task per trial, with up to
`--max-budget-usd` (default $15) and `timeoutMinutes` (40–90) each, plus the graders
(`type-check:all` and vitest suites). `--split all --runs 2` over the 7 seeded tasks can cost
around $100–200 and take hours. Start with `--case` and `--runs 1`. Never run it from CI or a
hook. `--dry-run` makes no model calls and is free.

## Tasks

| id | split | from | surfaces |
|---|---|---|---|
| kafka-registry-bearer-preset | **test** | #1153 | collection format, Kafka panel |
| graphql-messages-tab-fallback | **test** | #1156 | renderer (sanity task) |
| cli-graphql-get | train (seen) | #1161 (GraphQL half) | CLI vs app |
| mcp-runner-auth-vars | train | #1151 | runner on web + desktop |
| grpc-no-deadline | **test** | #1152 | web streams, runner, shared core, CLI |
| cli-grpc-wire-parity | train | #1161 (gRPC half) | CLI vs app |
| http-auth-vars-everywhere | train | #1163 | web, desktop main, CLI |

`mcp-runner-auth-vars` was first in test. The overlay leak check found that the harness has
seen it: `.claude/agents/restura-parity-checker.md` says "a second auth path must not overwrite
the first (see #1131)", which is this bug. It moved to train, and `kafka-registry-bearer-preset`
took its place in test.

Seed PRs that were **dropped** (their hidden tests are not a fair grader):

- **#1150** (MCP launch-settings toggle): the test asserts a Tailwind class (`flex-wrap`) and
  the DOM parent of the toggle. jsdom cannot observe layout, so a correct alternative layout fix
  fails it.
- **#1159** (broker preset credentials bound to the broker address): every new test calls
  `bindBrokerPresetCredentials`, an API the fix introduced. The issue cannot ask for it without
  dictating the solution.

Partly hidden: #1153 keeps only the OpenCollection round-trip test (its preset tests import a
function that is private at base), and #1161 / #1163 leave out the unit tests of the new
shared modules they created. Each task's `notes` says what was left out and why.

### Task format (`tasks/<id>.yaml`)

```yaml
id: kebab-case, equal to the file name
title: one line
split: train | test
base: <40-char SHA>             # the fix commit's FIRST PARENT (validated)
referenceCommit: <40-char SHA>  # the fix commit
issue: |                        # the ONLY thing the agent sees (plus a fixed suffix)
  Written like a GitHub issue: symptoms, repro, expected behaviour, affected surfaces
  (web / desktop / CLI). Never the solution, the fix's file names or the test names.
hiddenTests: [repo paths]       # test files taken from referenceCommit (must exist there)
failToPass: [shell commands]    # each must fail on base + hidden tests, pass on the reference
passToPass: [shell commands]    # must pass on the reference (e.g. npm run type-check:all)
timeoutMinutes: 60              # agent wall clock
commandTimeoutMinutes: 20       # optional, per grader command (default 20)
notes: what was left out, known grader caveats
leakTerms: [strings]            # optional: fix-specific symbols/module names (case-insensitive
                                # regex sources) that mark the task seen if the overlay has them
```

Commands run with `bash -c` from the isolated repo root (`cd cli && npx vitest run …` for the
CLI workspace, whose vitest config is separate). The validator rejects an issue that names a
hidden test path, basename or stem, or cites the reference commit.

### Adding a task from a fix PR

1. Pick a merged fix whose PR **shipped tests** that drive behaviour through interfaces that
   already exist at the base (public functions, components, executors against a local server).
   Tests that import a module or export the fix created are not self-contained: leave them out,
   or skip the PR.
2. `base` = `git rev-parse <fix>^1`, `referenceCommit` = the fix (squash-merged, so one commit).
3. Write `issue` from the PR's problem statement and the bug's observable behaviour. Include any
   user-visible text or status code the hidden tests assert (it is part of the expected
   behaviour); never the files, function names or design of the fix.
4. One `failToPass` command per hidden test file, so the validator can show each one detects
   the bug. `passToPass`: the touched features' suites and `npm run type-check:all`.
5. `node scripts/build-eval.mjs --dry-run --case <id>` must print `valid`. If a failToPass
   command passes on base it does not test the bug: move it to passToPass or drop it.
   Keep passToPass free of flaky suites: the CLI runner-level script / Set-Cookie tests
   (`cli/src/runner/__tests__/`) failed under load once in the first dry run, so CLI
   passToPass uses `src/runner/executors`.
6. Put it in `train` unless the test split needs it (see below), and add it to the table.

## Isolation

Each trial builds a fresh repo in a temp dir with `createIsolatedRepo` from
`scripts/harness-eval.mjs`: `git init`, the base **tree** from `git archive` committed as
`base`, then the harness overlay from `--harness-ref` (`.claude/skills`, agents, hooks,
`CLAUDE.md`, `AGENTS.md`, `docs/agents`, the worktree scripts) committed on top. No commits,
refs or objects of this repo come along, so `git log --all` cannot reach the fix; there is no
remote, so fetch and push fail closed. `node_modules` are symlinked from the main checkout.
`--harness-ref` is resolved once per invocation, so every task and trial tests the same harness;
only committed state is used.

The answer keys are stripped before the agent starts: `evals/` (which holds these task files)
is removed and the overlay commit amended, so no reachable tree contains it. Hidden test files
are only copied in after the agent finishes; when a hidden test path already exists at base
(an existing test file the fix extended) the run records it in `hiddenTestsAtBase` and the
agent sees base's version until grading overwrites it.

The agent runs `claude -p --output-format stream-json --verbose --permission-mode dontAsk`
with `Bash Read Edit Write Grep Glob Skill Task` allowed and `git push`, `gh`, `curl`, `wget`,
`WebFetch` and `WebSearch` disallowed, cwd the isolated repo, prompt = issue + "Fix this in the
repository following its CLAUDE.md workflow. Commit your work. Do not push or open PRs."
Disallow patterns are **not a sandbox**: `Bash` can still reach the network or the filesystem
by other means, and a local run has your developer privileges (keychain, SSH keys, tokens in the
environment). Prefer running real trials in CI or a container. Transcripts are saved as JSONL
next to the results. Transcripts, grader output tails and result files go through
`redactSecrets(text, env)` from `scripts/harness-eval.mjs` (secret-looking environment values)
before they are written; it is best-effort, so still skim before sharing. Ctrl-C / SIGTERM kills
every live child (`killLiveChildren`) and removes the trial's temp dir; a timed-out command gets
SIGTERM, then SIGKILL 10 s later.

Residual risks: the node_modules symlinks (and absolute paths in general) still lead to the main
checkout, so an agent that deliberately leaves its repo could read the history. Every
transcript is scanned with `detectContamination` (forbidden roots = the main checkout and this
checkout, plus their realpaths; git commands aimed outside the isolated repo); a contaminated
trial is an **error** and excluded from scoring.

The overlay docs come from the harness ref, which postdates the fixes, so a lesson written into
`CLAUDE.md` / skills / `docs/agents` can leak a task's answer. Each invocation reads the overlay
files at the harness ref (`readOverlayFiles`) and searches them (`findOverlayLeaks`) for the
task's terms: the PR numbers (`#NNNN`) in its title and notes, the reference commit's 8-char
short SHA, and its optional `leakTerms`. A task with a hit is tagged `seenInHarness` on every
run, its hits are listed under `overlayLeaks` in the result JSON, and the summary reports pass
rates for **all** tasks and for **unseen** tasks only. A seen **test**-split task prints a
warning: it is no longer held out, so move it to train or add a fresh task.

## Grading

Grading fails closed. A trial is graded only when claude exited 0 with a parseable stream, at
least one turn and no error, or when it stopped on **max turns** (graded on the outcome state).
A non-zero exit, a timeout kill, zero turns, unparseable output, or `is_error` / any other error
subtype (including running out of budget) is a harness **error**, excluded from scoring. For a
graded trial the runner:

1. records whether it committed (`git rev-list <effective base>..HEAD`) and left uncommitted
   changes; the grade uses the working tree either way;
2. copies every `hiddenTests` file from `referenceCommit`, **overwriting** the agent's version
   of that path;
3. runs each `failToPass` then `passToPass` command (timeout `commandTimeoutMinutes`), keeping
   status, exit code, duration and the last 2000 characters of output.

Outcome = `pass` only if **every** command passes. Partial credit = fraction of commands
passing. Transcript metrics per trial: turns, cost, minutes, tool / skill / subagent calls, and
whether the agent ran `type-check:all`, any test command and `git commit`.

Errors (excluded from pass rates and listed separately): contamination, the agent failures
above, or a setup failure. Budget stops are errors, so set `--max-budget-usd` high enough that
they are rare, and report the error count next to pass rates. The summary reports per task: scored trials, errors,
pass@1, pass^n (all n scored trials pass), mean partial credit, habit rates, mean cost and
minutes; and totals overall and per split with a Wilson 95% CI. Results:
`<out>/<timestamp>--<config>.json` + `.md`, transcripts under `<timestamp>--<config>/`.

## Train / test and no overfitting

Iterate on the harness (CLAUDE.md, skills, hooks) against **train** only. Run **test** rarely —
to confirm a change you already believe in — and never tune wording, skills or task text to a
test task's failure. Do not copy a task's issue, test names or fix into the harness. If a test
task's grader turns out to be unfair, fix or drop the task (and say so in the PR), do not adapt
the harness to it. With 7 tasks and 2 trials, differences under ~25 points are noise: read the
per-task flips and transcripts, not just the total.
