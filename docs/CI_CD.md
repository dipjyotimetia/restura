# CI/CD & Release Pipeline

This document describes Restura's continuous-integration and release pipeline,
the supply-chain security layers it ships with, and the **one-time repository
settings a maintainer must enable** to make the whole thing enforceable.

The workflow files themselves are the source of truth; this doc explains the
intent and the manual steps that can't live in a file (branch protection,
secret scanning, required reviewers, secrets).

---

## Workflows at a glance

| Workflow                  | File                                             | Trigger                                  | Purpose                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CI**                    | `.github/workflows/ci.yml`                       | PR + push to `main`                      | Type-check, lint, format, codegen gates, unit/integration tests, build, bundle size, e2e (web + Electron), docs build, PR preview deploy.                               |
| **CodeQL**                | _GitHub default setup_ (no workflow file)        | PR + push to `main`, weekly              | SAST over `javascript-typescript`. Managed in **Settings → Code security → Code scanning**, not a committed workflow.                                                   |
| **Scorecard**             | `.github/workflows/scorecard.yml`                | push to `main`, weekly, branch-prot edit | OpenSSF supply-chain posture score + badge.                                                                                                                             |
| **Merge lane**            | `.github/workflows/merge-lane.yml`               | push to `main`, CI completion, auto-merge enabled, every 30 min, manual | Keeps one auto-merge PR at a time up to date with `main` so its required checks run on the real tip (see [Merging](#merging-the-merge-lane)). |
| **Claude Code Review**    | `.github/workflows/claude-code-review.yml`       | PR opened / ready / reopened; `claude-review` label | Sonnet review of the PR. Skips drafts, bots, forks and docs/lockfile-only PRs, and PRs whose body carries a `/ship-check` READY marker for the exact head sha (`<!-- restura:ship-check verdict=READY sha=<sha> -->`, the local review already ran). The label always forces a run, plus the repo Correctness/Standards/Spec `code-review` skill. Both jobs follow `REVIEW.md` (evidence rule, Important / Nit / Pre-existing tags, nit cap, skip paths) and the label re-run counts rounds so findings are not repeated and the fourth round asks for a rethink. |
| **Eval harness**          | `.github/workflows/eval-harness.yml`             | manual dispatch; `eval-harness` label on a same-repo PR | Runs the seam-bug harness eval or the routing eval. **Costs money** (real model calls): default split `test`, 2 runs per case, per-run budget cap. The reviewer's Bash runs in the Claude Code sandbox with egress limited to the Claude API hosts and the npm registry (`sandbox: off` only to diagnose the sandbox). `save-baseline` also uploads a summary-only baseline to commit under `evals/harness/baselines/`. Uploads `.claude/metrics/evals/`. Never runs on push; not a required check. |
| **Dependency Review**     | `.github/workflows/dependency-review.yml`        | PR                                       | Blocks PRs that add high-severity-vulnerable or disallowed-license deps; warns on new deps with an OpenSSF Scorecard below 3.                                            |
| **Workflow lint**         | `.github/workflows/workflow-lint.yml`            | PR / push touching `.github/**`, weekly, manual | [zizmor](https://docs.zizmor.sh) static analysis of every workflow, action and `dependabot.yml`; SARIF to code scanning (category `zizmor`); fails on medium+ findings. |
| **Security Audit**        | `.github/workflows/security-audit.yml`           | weekly, manual                           | Non-blocking `npm audit --audit-level=critical` (visibility net; Dependabot is the fix path).                                                                           |
| **Dependabot auto-merge** | `.github/workflows/dependabot-auto-merge.yml`    | PR (Dependabot only)                     | Approves (as restura-bot) and auto-merges patch/minor dependency updates once required checks pass (see §4).                                                            |
| **Dependabot alert remediation** | `.github/workflows/dependabot-remediate.yml` | Every 5 days + manual | Claude fixes open Dependabot alerts; a policy gate checks the patch and restura-bot opens and auto-merges the PR (see §4). |
| **OpenWiki update**       | `.github/workflows/openwiki-update.yml`          | weekly, manual                           | Runs [OpenWiki](https://github.com/langchain-ai/openwiki) against OpenRouter to diff recent commits and open a PR updating `openwiki/`, the agent-facing docs (see §8). |
| **Release**               | `.github/workflows/release.yml`                  | **manual** (`workflow_dispatch`)         | Versioned, attested release: tag → notes → SBOM → desktop installers → provenance → npm CLI (trusted publishing) → Docker → Cloudflare.                                 |
| **Release signing check** | `.github/workflows/release-signing-check.yml`    | weekly, manual, signing config on `main` | Signs the macOS app with the real Developer ID cert (no notarize, no publish) so signing regressions surface before release day.                                        |
| **VS Code extension**     | `.github/workflows/extension-vscode-release.yml` | tag `vscode-v*.*.*` + manual dry-run     | Package + publish `restura-vscode` to the VS Code Marketplace + Open VSX; attach `.vsix` to a GitHub release.                                                           |
| **Chrome extension**      | `.github/workflows/extension-chrome-release.yml` | tag `chrome-v*.*.*` + manual dry-run     | Build + zip the MV3 bundle, upload to the Chrome Web Store; attach `.zip` to a GitHub release.                                                                          |

> Releases are **never** cut on merge to `main`. Production ships only from a
> manually-dispatched **Release** run (desktop/web/CLI) or a pushed `*-v*` tag
> (extensions). See the [release runbook](#release-runbook) below and the
> dedicated [extension release runbook](./EXTENSION_RELEASE.md).

---

## Supply-chain security layers

The threat model, the incident runbook and the review cadence live in
[`SUPPLY_CHAIN_HARDENING.md`](./SUPPLY_CHAIN_HARDENING.md); user-facing
verification steps are in [`SECURITY.md`](../SECURITY.md#verifying-downloads).

| Layer                          | Where                                  | What it gives you                                                                    |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------ |
| **SAST**                       | CodeQL (default setup)                 | Code-scanning alerts on the app source.                                              |
| **Workflow lint**              | zizmor (`workflow-lint.yml`)           | Template injection, excessive permissions, credential persistence, cache poisoning, unpinned/impostor actions. |
| **Supply-chain scoring**       | OpenSSF Scorecard                      | Public score + SARIF; backs the README badge.                                        |
| **Dependency gate**            | `dependency-review-action`, Dependabot | High-severity / disallowed-license deps blocked at PR; weekly update + security PRs. |
| **No install scripts in CI**   | `npm ci --ignore-scripts` for repo deps | A dependency's install script never runs in CI or release jobs; jobs `npm rebuild` only the approved packages they need. Pinned tools under `.github/tools/` follow their own `allowScripts`. |
| **Install-script review**      | `allowScripts` + `npm run lockfile:check` | Every lockfile entry with an install script needs a reviewed `true`/`false` decision in `package.json`. |
| **Lockfile sources**           | `npm run lockfile:check`               | Every committed lockfile resolves only from `registry.npmjs.org` with an `integrity` hash. |
| **Registry signatures**        | `npm audit signatures`                 | Run after install in `validate-static-build` and every release job that installs.   |
| **Imported skill integrity**   | `npm run skills:check`                 | `.agents/skills/*` must match the hashes in `skills-lock.json`.                      |
| **Build provenance (npm)**     | npm trusted publishing (OIDC)          | `restura-cli` published without any npm token; provenance attached automatically.    |
| **Build provenance (desktop)** | `actions/attest-build-provenance`      | Signed provenance for every installer, minted in `attest-desktop` (no npm code).     |
| **Build provenance (image)**   | `actions/attest-build-provenance`      | Signed provenance for the GHCR image, minted in `attest-image` and pushed alongside it. |
| **Container CVE scan**         | `aquasecurity/trivy-action`            | Image scanned on publish; results in code scanning (report-only, `ignore-unfixed`).  |
| **SBOM**                       | `@cyclonedx/cyclonedx-npm`             | CycloneDX SBOM (JSON + XML) attached to every GitHub release.                        |
| **Signed + notarized desktop** | electron-builder + Apple notary        | macOS/Windows code signing when certs are configured.                                |

### Verifying attestations

```bash
# Desktop installer (download from the release first)
gh attestation verify Restura-<version>.dmg --repo dipjyotimetia/restura

# GHCR image
gh attestation verify oci://ghcr.io/dipjyotimetia/restura:<version> \
  --repo dipjyotimetia/restura

# npm CLI provenance
npm view restura-cli --json | jq .dist.attestations
npm audit signatures   # in a project that depends on restura-cli
```

---

## One-time maintainer setup

These cannot be committed to the repo — enable them in the GitHub UI / CLI.

### 1. Branch protection on `main`

**Settings → Branches → Add branch ruleset** (or classic _Branch protection
rules_) for `main`:

- ✅ **Require a pull request before merging** (≥ 1 approval; _Require review
  from Code Owners_ — `CODEOWNERS` already routes to `@dipjyotimetia`).
- ✅ **Require status checks to pass before merging** + **Require branches to be
  up to date**. Select these checks (names must match exactly — these are the
  job `name:` values that run on **pull requests**):

  | Required check                                       | From                         |
  | ---------------------------------------------------- | ---------------------------- |
  | `validate` (merged Vitest shards + coverage)         | CI / `validate`              |
  | `Static, build, and workspace validation`            | CI / `validate-static-build` |
  | `Docs site (type-check + build + production deploy)` | CI / `docs`                  |
  | `Review dependency changes`                          | Dependency Review            |

  `validate` alone is **not** enough: type-check, lint, format, codegen and the
  production builds run in `validate-static-build`, and Dependabot auto-merge
  waits only on required checks.

  **Skipped jobs count as passing.** A job skipped by its job-level `if:` (for
  example the e2e jobs when the `Detect app changes` job reports `app=false`, or
  the Electron jobs on Dependabot PRs) reports a successful required check. So
  the e2e checks below can be required without blocking docs-only PRs.

  Recommended-but-heavier (enable once you're comfortable with their runtime /
  flakiness budget):

  | Optional check (exact check name)      | From                           |
  | -------------------------------------- | ------------------------------ |
  | `Playwright E2E (shard 1/4)`           | CI / `e2e`                     |
  | `Playwright E2E (shard 2/4)`           | CI / `e2e`                     |
  | `Playwright E2E (shard 3/4)`           | CI / `e2e`                     |
  | `Playwright E2E (shard 4/4)`           | CI / `e2e`                     |
  | `Electron desktop E2E`                 | CI / `e2e-electron`            |
  | `Electron critical-path coverage`      | CI / `electron-critical-coverage` |
  | `Electron pack smoke (ubuntu-latest)`  | CI / `electron-smoke`          |
  | `Electron pack smoke (macos-latest)`   | CI / `electron-smoke`          |
  | `Electron pack smoke (windows-latest)` | CI / `electron-smoke`          |
  | `Extension build + E2E`                | CI / `e2e-extension`           |

  `Vitest (shard 1/4)` … `(4/4)` need not be required: `validate` fails when
  any shard fails. Leave `VS Code extension integration` optional (it
  downloads VS Code and can flake).

  > Do **not** require `Deploy preview` — it is skipped on forked PRs by design,
  > and a required check that never runs blocks the merge.

- ✅ **Require conversation resolution before merging.**
- ✅ Configure the **Main protection with release-bot bypass** repository
  ruleset: it requires the checks above and one approval, with a
  pull-request-only bypass for the `restura-bot` GitHub App. Do not recreate a
  legacy branch-protection rule for `main`: personal repositories cannot scope
  that rule's review bypass to an App.
- ✅ **Require signed commits** (optional, recommended).
- ⛔ Block force-pushes and deletions of `main`.

> The stable Release workflow validates `main`, then creates a dedicated
> version-only `release/prepare` PR with the `restura-bot` GitHub App token and
> immediately merges it through the App's pull-request bypass. It does not wait
> for candidate-PR CI, because the candidate contains only the validated version
> manifests. This avoids GitHub's generic auto-merge executor, which cannot use
> an App's review bypass. The merged PR triggers publication of its exact merge
> commit.
> Do not add a bypass for `github-actions[bot]`.

### 2. Code scanning (CodeQL)

CodeQL runs via GitHub **default setup** (enabled in **Settings → Code security
→ Code scanning**), not a committed workflow. Default setup and an advanced
`codeql.yml` are mutually exclusive — enabling both makes the advanced run fail
to upload (`analyses from advanced configurations cannot be processed when the
default setup is enabled`), which is why there is no `codeql.yml` here.

- **Recommended (#1295):** edit default setup, add the **GitHub Actions**
  (`actions`) language and switch the query suite to **`security-extended`**.
  The `actions` language catches script injection and unsafe
  `pull_request_target` / `workflow_run` use in workflows, complementing zizmor.
- To switch to an advanced workflow instead (e.g. for `security-extended` +
  `actions` + a weekly schedule in code), first **disable default setup**, then
  add a `codeql.yml`. Don't run both.

### 3. Secret scanning + push protection

**Settings → Code security:**

- ✅ **Secret scanning** — on.
- ✅ **Push protection** — on (blocks commits that contain a recognized secret).
- ✅ **Validity checks** (where available).

### 4. Dependabot auto-merge

Dependabot updates are **grouped** (`.github/dependabot.yml`): each weekly run
opens one PR for all root npm patch/minor bumps, one for `docs-site`, and one
for GitHub Actions. Majors arrive separately (families such as React, Vite/
Vitest, Radix, protobuf and Astro are grouped) and always need manual review.

`dependabot-auto-merge.yml` approves patch/minor PRs as **restura-bot** and
queues auto-merge; GitHub merges once the required status checks (step 1) go
green. Major bumps and non-semver updates are left for manual review.

To make it work:

- ✅ **Settings → General → Pull Requests → "Allow auto-merge"** — on. Without
  this, `gh pr merge --auto` errors and nothing merges.
- ✅ **Branch protection with required status checks** (step 1). `--auto` waits
  on _required_ checks only; a red required check holds the merge.
- ✅ **Actions secrets `RELEASE_PR_APP_ID` + `RELEASE_PR_APP_PRIVATE_KEY`** — the
  restura-bot App the release flow already uses. `GITHUB_TOKEN` cannot approve
  PRs; without the App the workflow warns and the PR waits for a human approval.
  The workflow runs on `pull_request_target` (always `main`'s copy of the file,
  never PR code) and scopes the minted token to `pull-requests: write`, so a
  Dependabot PR bumping an action cannot hand the App key to unreviewed code.

How Dependabot runs are hardened (in `ci.yml`):

- **`--ignore-scripts`** on every `npm ci` — for every CI run, not only
  Dependabot's, so an updated package's lifecycle scripts never execute in the
  merge-gating jobs. A bump that introduces a new install script fails
  `npm run lockfile:check` until someone records an `allowScripts` decision.
  (Dependabot runs also get a read-only token and no secrets by default.)
- **Cooldowns** (`.github/dependabot.yml`): routine bumps wait until a release
  has been public for 3–7 days (7 by default, and for every GitHub Actions
  bump), long enough for most malicious releases to be yanked. Security updates
  bypass the cooldown.
- **Majors are never auto-merged** — only semver patch/minor updates qualify.
- **`deploy-preview` is skipped** — Dependabot has no Cloudflare secrets and a
  preview of a dep bump has no value.
- **PR test-result / coverage comments are skipped** — the read-only Dependabot
  token can't post them (would 403 and fail the job).

Tune the auto-merge scope (e.g. patch-only) by editing the `case` in the
`Classify update` step of `dependabot-auto-merge.yml`.

#### Dependabot alert remediation

`dependabot-remediate.yml` handles what grouped version updates don't: open
security alerts, including transitive ones that need a parent bump or an override.
Actions has no Dependabot-alert event, so it polls every 5 days (`workflow_dispatch`
to run now). A new alert can wait up to 5 days. A poll with nothing to do makes no model calls.

1. **Detect** lists open npm alerts, reduced to validated fields so advisory prose
   never reaches the agent. It stops if a remediation PR is open, or if this exact
   alert set was already attempted (dispatch with `force` to retry; the marker
   expires with the Actions cache after about a week without use).
2. **Remediate** runs Claude with the `dependabot-remediate` skill, a read-only
   `GITHUB_TOKEN`, no App key, and tools limited to the manifests and lock-only npm
   commands. Its only output is a patch.
3. **Publish** runs `scripts/dependabot-remediate.mjs verify` from the commit on
   `main`, then mints the restura-bot token, pushes `deps/dependabot-remediate` and
   opens the PR.

| Verdict  | When                                                                                                                        | Result                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `reject` | Touches anything but dependency versions and overrides, a lock entry isn't that package's npm tarball, or no alert is fixed | No PR, the workflow fails |
| `hold`   | Runtime or direct major bump, a new install script, or more than 25 new packages                                            | PR without auto-merge     |
| `merge`  | Everything else                                                                                                             | PR with `--auto --squash` |

Auto-merge is the normal lane, so all required checks apply on an up-to-date branch.
It never uses `--admin`. CI treats this branch like a Dependabot PR (`--ignore-scripts`,
no deploy preview, no Electron jobs), because it can bring in a brand-new release:
security fixes skip the Dependabot cooldown by design.

Prerequisites:

- ✅ Secrets `RELEASE_PR_APP_ID`, `RELEASE_PR_APP_PRIVATE_KEY` and
  `CLAUDE_CODE_OAUTH_TOKEN`.
- ⚠️ The restura-bot App needs **Dependabot alerts: read**, on top of the contents
  and pull-request access the release flow uses. Add it in the App's settings, then
  accept the change on its installation. Without it, the `detect` job fails when
  minting its token.

### 5. OpenSSF Scorecard

- No token needed for a **public** repo — `scorecard.yml` uses OIDC
  (`id-token: write`) and `publish_results: true`.
- The README badge (`api.securityscorecards.dev/...`) resolves after the first
  scheduled/`main` run completes.
- Scorecard will score higher once branch protection (step 1) is in place.

### 6. Release secrets

The Release **preflight** job fails fast if a stable release is missing any of
these. Set them in **Settings → Secrets and variables → Actions** (repository
secrets — see §7 for why `release.yml` does not use a protected environment
yet):

| Secret                                                     | Required for            | Notes                                                   |
| ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                                     | web deploy              | Pages + Workers deploy scope.                           |
| `CLOUDFLARE_ACCOUNT_ID`                                    | web deploy              |                                                         |
| `WORKER_PROXY_TOKEN`                                       | web build/deploy        | Injected into the production build + Worker auth gate.  |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | macOS signing           | Required for stable releases; base64 `.p12` + password. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization      | Required for stable releases.                           |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                     | Windows signing         | Optional until a Windows certificate is available.      |
| `SENTRY_DSN`                                               | desktop crash reporting | Required for stable releases; public ingest id.         |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`        | source-map upload       | Required for stable releases; symbolicated stacks.      |

> `GITHUB_TOKEN` is automatic. `GHCR` publish uses it (`packages: write`).
>
> **No npm token.** `restura-cli` publishes through
> [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): on
> npmjs.com → `restura-cli` → *Settings → Trusted publishing*, add GitHub
> Actions with owner `dipjyotimetia`, repository `restura`, workflow
> `release.yml` and no environment. Configure it **before** the first stable
> release on this workflow (otherwise `publish-cli` fails with 403/404 and can
> be re-run once it's set). After one successful publish, set *Publishing
> access → Require two-factor authentication and disallow tokens* and revoke any
> remaining npm automation token.

The **extension** release workflows use a separate set of secrets, read only by
their `publish` jobs, which run in the **`extensions`** environment (§7). They
are all optional — each publish step self-skips when its secrets are absent, so
a tagged run still builds, packages, and attaches the artifact to a GitHub
release:

| Secret                                                                                    | Required for        | Notes                                           |
| ----------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------- |
| `VSCE_PAT`                                                                                | VS Code Marketplace | Azure DevOps PAT, Marketplace **Manage** scope. |
| `OVSX_PAT`                                                                                | Open VSX (optional) | Open VSX access token.                          |
| `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` | Chrome Web Store    | OAuth2 creds; see the extension runbook.        |

> Full step-by-step in the [extension release runbook](./EXTENSION_RELEASE.md).

### 7. Deployment environments

- ✅ **`extensions`** (**Settings → Environments → New environment**). The
  `publish` jobs of both extension release workflows declare
  `environment: extensions`. Under *Deployment branches and tags* choose
  *Selected* and add the **tag** rules `vscode-v*` and `chrome-v*`, then move
  `VSCE_PAT`, `OVSX_PAT` and the four `CHROME_*` secrets from repository to
  environment secrets. Required reviewers are optional. Until you create it,
  GitHub auto-creates an unprotected `extensions` environment on the first run
  and the jobs keep reading the repository secrets, so nothing breaks in the
  meantime.
- ⏸ **`release`** (not used yet). The stable publish run of `release.yml` is
  triggered by the merged `release/prepare` PR (`pull_request: closed`), so its
  `GITHUB_REF` is `refs/pull/<n>/merge`. A deployment rule of `main` / `v*`
  would refuse those jobs, and allowing `refs/pull/*/merge` would let any
  same-repo PR's copy of the workflow read the secrets. Moving the publish run
  to a `push`/dispatch trigger is the prerequisite; see
  [`SUPPLY_CHAIN_HARDENING.md` §4](./SUPPLY_CHAIN_HARDENING.md#4-deliberately-not-done-yet).

### 8. OpenWiki documentation updates

`openwiki-update.yml` runs [OpenWiki](https://github.com/langchain-ai/openwiki)
weekly to keep `openwiki/` — the machine-readable docs coding agents reference —
in sync with recent commits. It opens a PR rather than pushing directly.

CI-only tools installed outside the root lockfile (OpenWiki here, the Claude Code
CLI in `eval-harness.yml`, the CycloneDX SBOM generator in `release.yml`, and the
marketplace publishers in the extension workflows) are pinned by lockfile under
`.github/tools/<tool>/` and installed with `npm ci --prefix`, so every
transitive package is integrity-checked (OpenSSF Scorecard
*Pinned-Dependencies*) and covered by `npm run lockfile:check`. Each tool's
`package.json` carries its own `allowScripts` decisions. To bump one, edit its
`package.json` and run `npm install --package-lock-only --ignore-scripts` in
that folder. Dependabot proposes monthly, cooled-down bumps for every
`.github/tools/*` folder.

- ✅ Set **`OPENROUTER_API_KEY`** in **Settings → Secrets and variables →
  Actions**. This is the only required secret; the workflow defaults
  `OPENWIKI_MODEL_ID` to `deepseek/deepseek-v4-pro` (1M context, cheaper on
  both input and output than OpenWiki's own `z-ai/glm-5.2` default — chosen
  for price; edit the `env:` block in the workflow to point at a different
  model or provider, e.g. `deepseek/deepseek-v4-flash` for an even cheaper,
  lower-fidelity run).
- ✅ **Settings → Actions → General → Workflow permissions → "Allow GitHub
  Actions to create and approve pull requests"** — on. `peter-evans/create-pull-request`
  uses the default `GITHUB_TOKEN` to open the PR; without this setting the step
  fails with a `GitHub Actions is not permitted to create or approve pull
requests` error.
- The workflow only ever touches `openwiki/` (`add-paths: openwiki`) and opens
  against a stable `openwiki/update` branch, so repeated runs update the same
  PR instead of piling up new ones.
- First run must be a manual **Actions → OpenWiki Update → Run workflow**
  dispatch (or `openwiki --init` run locally and committed) to seed the
  `openwiki/` directory — the scheduled job only handles incremental `--update`
  diffs.


### AI-agent workflows

**Rule:** an agent that reads untrusted input (issue or PR text, diffs, commit
messages, advisory text, web pages) never holds a token that can push to
`main`, publish, deploy or read release secrets. Anything an agent produces
lands as a PR that goes through the same required checks and human review as
any other PR. Neither the Claude GitHub App nor the GitHub Actions identity has
a bypass on the `main` ruleset (check this when you edit the ruleset);
restura-bot's bypass is used only by `release.yml` and the merge lane, which
run no agent.

| Workflow | Untrusted input it reads | Gating | Tokens it holds | Agent tools |
|---|---|---|---|---|
| `claude.yml` | Issue / PR / review text in the thread | `@claude` from OWNER, MEMBER or COLLABORATOR only; no bots | `GITHUB_TOKEN` read-only; Claude App token via OIDC (comments, branch pushes, never `main`) | `claude-code-action` defaults (no `--allowedTools` override), 30 turns |
| `claude-code-review.yml` | PR diff and description | Same-repo, non-draft, non-bot PRs; `claude-review` label to re-run | `GITHUB_TOKEN` read-only; Claude App token via OIDC | Explicit allowlist: read/search tools, `git diff/log/rev-parse`, `gh pr view/diff/comment`, `gh issue view/list`, `gh search`, inline comments; no general `Bash` |
| `claude-security-review.yml` | PR diff | Same-repo, non-draft, non-bot PRs; label to re-run | `GITHUB_TOKEN` read-only; Claude App token via OIDC | Explicit allowlist: read/search tools, `git diff/log/show`, `gh pr view/diff/comment`; no general `Bash` |
| `dependabot-remediate.yml` | Dependabot alert and advisory text | Schedule / dispatch, `main` only | Remediate job: `contents: read`; the restura-bot token exists only in the later `publish` job, after a policy gate checks the patch | `Read/Glob/Grep`, `Edit` of `package.json` files only, `npm install/update --package-lock-only --ignore-scripts`, `npm ls/explain/view/audit` |
| `eval-harness.yml` | Eval cases (repo content) and a same-repo PR | Dispatch, or `eval-harness` label on a same-repo, non-bot PR | `contents: read`; Claude OAuth token | `Bash` inside the Claude Code sandbox, egress limited to the Claude API and the npm registry |
| `openwiki-update.yml` | Commit history | Schedule / dispatch | Job `contents`/`pull-requests: write`, but the checkout token is not persisted; the PR is opened by `create-pull-request`, not by the agent | OpenWiki CLI (OpenRouter) |

Agent configuration (`.claude/`, `.agents/`, `AGENTS.md`, `CLAUDE.md`,
`skills-lock.json`) is a sensitive path in `.github/CODEOWNERS`. Review hook and
skill changes like CI changes. Imported skills must match `skills-lock.json`
(`npm run skills:check`).

---

## Merging: the merge lane

GitHub's merge queue is only available to organization-owned repositories, so
Restura uses a **serialized merge lane** instead. The goal is the same: no PR
merges unless its required checks ran on top of everything merged before it.
PRs that were green alone used to break `main` together because each PR's CI
had run against an older `main`.

How it works:

1. The `main` ruleset requires checks to pass **and the branch to be up to
   date** with `main` (strict required checks).
2. You merge with **`gh pr merge <n> --auto --squash`** (or the "Enable
   auto-merge" button). Nothing merges until the required checks are green on
   an up-to-date branch.
3. `merge-lane.yml` runs `scripts/merge-lane.mjs` on every push to `main`, when
   CI completes, when auto-merge is enabled, every 30 minutes, and on manual
   dispatch. It picks **one** PR at a time:
   - If an auto-merge PR is already up to date and its checks are still running
     (or it is mergeable and about to land), it waits.
   - Otherwise it updates the oldest auto-merge PR (by when auto-merge was
     enabled) that is behind `main` (`PUT /pulls/{n}/update-branch`), so its CI
     re-runs on the current tip. PRs whose review is still required, drafts,
     fork PRs, and PRs labelled `merge-lane:hold` are skipped.
   - A PR that conflicts with `main` is labelled `merge-lane:conflict` and
     gets one comment asking for a manual rebase. The label is removed when it
     no longer conflicts.
4. Auto-merge squash-merges the PR once green. The push to `main` triggers the
   lane again and the next PR is updated.

A PR whose checks fail on the updated branch stays open (with auto-merge
still enabled) and the lane moves on; push a fix and it rejoins.

Requirements and safety:

- Uses the **restura-bot** GitHub App token (`RELEASE_PR_APP_ID` /
  `RELEASE_PR_APP_PRIVATE_KEY`), scoped to `contents: write` +
  `pull-requests: write`. A push made with `GITHUB_TOKEN` would not trigger CI
  on the updated PR. Without the secrets the lane logs a warning and does
  nothing.
- It never checks out or runs PR code: the only checkout is
  `scripts/merge-lane.mjs` from the default branch, without persisted
  credentials. `pull_request_target` is used only as a wake-up signal.
- Preview the plan without acting: **Actions → Merge lane → Run workflow** with
  `dry_run`, or locally `node scripts/merge-lane.mjs --repo dipjyotimetia/restura --dry-run`
  (needs `gh auth`).

**`gh pr merge --admin` bypasses the required checks and the up-to-date
requirement.** Use it only in an emergency (for example, a broken `main` that
blocks every PR), and expect to run `npm run integration-check` or wait for the
next `main` CI run to confirm the result.

### Before you queue related PRs

Run the combined gates locally on the branches you plan to merge:

```bash
npm run integration-check -- origin/feat/a origin/feat/b [--base origin/main] [--e2e] [--keep]
```

See [CONTRIBUTING.md](../CONTRIBUTING.md#testing-several-branches-together) for
the output and options.

## Local hooks and guardrails

| Guardrail | Where | What it does |
| --- | --- | --- |
| Staged-file guard | `.husky/pre-commit` → `scripts/guard-staged.mjs` | Rejects new symlinks (relative `.claude/skills/*` links allowed), `node_modules` paths, `.dev.vars`, `*.snap` (gitignored, so absent in CI), and added lines containing a machine-local absolute repo path. |
| lint-staged | `.husky/pre-commit` | `biome check --write` on staged files; `--no-errors-on-unmatched` so commits that only stage Biome-ignored files pass. |
| Fast pre-push | `.husky/pre-push` | `type-check:related` (`scripts/type-check-related.mjs`: the tsconfig projects the branch touched, every project when `shared/` or a root config changed), `architecture:check`, `capabilities:check`, `biome:ci`, and `vitest related` for files changed since the merge-base with `origin/main`. `RESTURA_PREPUSH_FULL=1 git push` runs the full `test:coverage` instead. Full coverage is enforced by CI on every PR and re-run on the up-to-date branch by the merge lane. |
| Worktree setup | `npm run worktree:setup [-- <path>] [--hooks]` | Links every installed `node_modules` from the main checkout, copies `.dev.vars`, checks the links are gitignored, and reports (or with `--hooks`, fixes) worktrees that run the main checkout's hooks. |
| Integration check | `npm run integration-check -- <branch...>` | Merges branches onto a fresh base in a throwaway worktree, prints the file-overlap matrix, runs the gates on the result. Never pushes. |
| Architecture caps | `npm run architecture:check` / `architecture:tighten` | Caps fail only when exceeded; looser-than-code caps are warnings. `architecture:tighten` lowers them to the code (never raises). Also hard-fails on the IPC triple and forbidden config keys. |

---

## Release runbook

1. Ensure `main` is green and carries everything you want to ship.
   Configure a GitHub App installed only on this repository with **Contents:
   read/write** and **Pull requests: read/write**, then save its ID and private
   key as `RELEASE_PR_APP_ID` and `RELEASE_PR_APP_PRIVATE_KEY`. The App creates
   the version-bump PR so its normal CI runs automatically rather than waiting
   for a manual workflow approval.
2. **Actions → Release → Run workflow** (on `main`) to prepare the version-bump
   PR, or run:
   ```bash
   gh workflow run release.yml --ref main \
     -f release_bump=patch        # patch | minor | major
     # -f prerelease=true -f prerelease_identifier=beta.1   # for a beta
   ```
3. For a stable release, the generated `chore(release): vX.Y.Z` version-only
   PR is immediately merged by `restura-bot` through its App-only bypass; it
   does not wait for candidate-PR CI. The merged PR automatically starts
   publication. The workflow uses that exact merge commit, so later `main`
   commits are excluded.
4. The publish run: **release-secrets** (presence checks only, no checkout;
   this includes the restura-bot App credentials) → **preflight** → **sbom**
   → **release** (annotated tag + draft release, both as the restura-bot App,
   with the SBOM attached) → **desktop** (signed installers uploaded
   to the draft) → **attest-desktop**, **build-cli** → **publish-cli**,
   **publish-docker** → **attest-image**, **deploy-web** →
   **publish-release** (flips the draft to public once every required
   downstream job, including both attestations, succeeds). Jobs that hold
   `id-token: write` (`attest-desktop`, `attest-image`, `publish-cli`) install
   no dependencies and run no repo build; they work only on the artifacts the
   earlier jobs uploaded. Desktop runs first because signing/notarization is
   the likeliest failure; until it succeeds nothing irreversible has shipped.
   Preflight skips `npm run validate` when the merged commit is the
   dispatch-validated commit plus a version-only bump (checked by
   `scripts/release-version.mjs version-only-diff`); any other difference runs
   the full validate. Versions are computed from `package.json`
   (`scripts/release-version.mjs next`), not from git tags.
5. The stable macOS desktop leg fails closed unless the app is Developer ID
   signed for `APPLE_TEAM_ID`, uses the configured bundle identifier and
   hardened runtime, passes strict `codesign` verification, and retains a
   valid notarization ticket after the updater ZIP is created. The desktop
   matrix must succeed before the draft can become public.
6. Verify the published artifacts with the `gh attestation verify` commands above.

The merged release PR is still a `pull_request` event. Electron-builder skips
both publishing and signing in that context unless explicitly authorized, so
`PUBLISH_FOR_PULL_REQUEST` and `CSC_FOR_PULL_REQUEST` intentionally share one
predicate restricted to a same-repository PR merged from `restura-bot`. Never
loosen or update one without the other;
`tests/release-sentry-workflow.test.ts` enforces parity.

### Recovery after a failed stable run

**Transient failure after the tag and draft exist (notarization timeout, runner
flake).** Use **Re-run failed jobs** on the original run — no code change or
retry needed. Re-run does not pick up a workflow file that landed later.

**The version bump is on `main` but the tag was never created, or only an
unpublished draft and tag exist** (tag ruleset rejection, cancelled job,
manual delete of a release). Merge any workflow fix to `main` without another
version bump. A normal **Release** dispatch is refused while `package.json` is
ahead of the latest published stable release, because that bump would skip the
unpublished version. Retry the same version from current `main` HEAD:

```bash
gh workflow run release.yml --ref main -f retry_release_tag=vX.Y.Z
```

Leave `prerelease` off. Leave `publish_docker` off unless this release should
push a GHCR image. The retry re-runs preflight on HEAD, requires HEAD's
`package.json` version to equal `X.Y.Z`, deletes the unpublished draft and tag
as restura-bot, and re-tags HEAD. It refuses if the release is already public
or `restura-cli@X.Y.Z` is on npm. If the tag push or delete is rejected with
"creations being restricted" (or the deletion equivalent), the `v*` ruleset
bypass list is missing the restura-bot App (`RELEASE_PR_APP_ID`). Add that App
for creation, update, and deletion. Leave the ruleset in place, and do not add
`github-actions[bot]`.

**Desktop (or anything before it) failed and needs a code fix.** npm, Docker,
and the web deploy wait for desktop. Same retry as above after the fix is on
`main`.

**npm, Docker, or Cloudflare failed after desktop succeeded.** These are
transient (credentials, outages) and need no code change. Use **Re-run failed
jobs** on the original run so every surface ships from the same commit; the npm
step is idempotent.

**Partly public and not recoverable by re-run.** Cut a new patch release.

Once a release is public, its updater assets are immutable. Do not replace a
ZIP, installer, blockmap, or `latest*.yml` file under the same version: clients
may already have cached the original metadata or payload. Fix the release path,
publish a new patch version, and verify an N-1 installation can download,
validate, install, and relaunch into that patch.

---

## Performance notes

- All `npm ci` steps run with `--prefer-offline --no-audit --no-fund` to skip
  the audit round-trip and prefer the restored npm cache.
- Playwright browsers are cached against `package-lock.json`; e2e runs in 4
  shards on separate runners. Playwright's `--shard` splits by test count, which
  left one shard at ~230 s of test time and the others at 40-90 s, so CI runs
  whole spec files assigned by `scripts/e2e-shard.mjs` from a per-spec duration
  table (longest-first packing, ~110 s each). A new spec still runs (default
  weight); refresh `SPEC_SECONDS` from the `list` report in the CI log when
  specs change a lot. `scripts/__tests__/e2e-shard.test.mjs` fails if the table
  and `e2e/` drift apart.
- The Electron desktop E2E, Electron pack smoke and VS Code integration jobs do
  not wait for `validate` (they build the app themselves), so they start with
  the Vitest shards instead of ~4.5 minutes later. A red unit run still blocks
  merge through the required `validate` check.
- Vitest runs two projects (`vitest.config.ts`): `dom` (jsdom) for `src/**` and
  `node` for `shared/`, Electron main, Worker, echo and `tests/`. Only the two
  DOM suites in `tests/security/` are pinned to jsdom (`domTests`). jsdom setup
  was ~45% of each shard's time.
- `setup-node` caches the npm download cache on every job.
- CodeQL and Scorecard run as standalone workflows in parallel with CI — they
  do not lengthen the CI critical path (they only gate merges if you mark them
  required in step 1).
