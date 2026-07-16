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
| **Dependency Review**     | `.github/workflows/dependency-review.yml`        | PR                                       | Blocks PRs that add high-severity-vulnerable or disallowed-license deps.                                                                                                |
| **Security Audit**        | `.github/workflows/security-audit.yml`           | weekly, manual                           | Non-blocking `npm audit --audit-level=critical` (visibility net; Dependabot is the fix path).                                                                           |
| **Dependabot auto-merge** | `.github/workflows/dependabot-auto-merge.yml`    | PR (Dependabot only)                     | Enables auto-merge for patch/minor dependency updates once required checks pass (no self-approval — see §4).                                                            |
| **OpenWiki update**       | `.github/workflows/openwiki-update.yml`          | daily, manual                            | Runs [OpenWiki](https://github.com/langchain-ai/openwiki) against OpenRouter to diff recent commits and open a PR updating `openwiki/`, the agent-facing docs (see §8). |
| **Release**               | `.github/workflows/release.yml`                  | manual dispatch + trusted release-PR close | Versioned, attested release: prepare by dispatch, then publish the exact merged candidate after its complete CI proof.                                                  |
| **VS Code extension**     | `.github/workflows/extension-vscode-release.yml` | tag `vscode-v*.*.*` + manual dry-run     | Package + publish `restura-vscode` to the VS Code Marketplace + Open VSX; attach `.vsix` to a GitHub release.                                                           |
| **Chrome extension**      | `.github/workflows/extension-chrome-release.yml` | tag `chrome-v*.*.*` + manual dry-run     | Build + zip the MV3 bundle, upload to the Chrome Web Store; attach `.zip` to a GitHub release.                                                                          |

> Ordinary merges to `main` never cut a release. A maintainer manually starts
> the stable release flow; after its trusted version-only PR merges, the PR-close
> event resumes publication for that exact candidate. Extensions still publish
> from explicit `*-v*` tags. See the [release runbook](#release-runbook) and the
> dedicated [extension release runbook](./EXTENSION_RELEASE.md).

---

## Supply-chain security layers

| Layer                          | Where                                  | What it gives you                                                                    |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------ |
| **SAST**                       | CodeQL (default setup)                 | Code-scanning alerts on the app source.                                              |
| **Supply-chain scoring**       | OpenSSF Scorecard                      | Public score + SARIF; backs the README badge.                                        |
| **Dependency gate**            | `dependency-review-action`, Dependabot | High-severity / disallowed-license deps blocked at PR; weekly update + security PRs. |
| **Build provenance (npm)**     | `npm publish --provenance`             | Signed SLSA provenance for `restura-cli` on npm.                                     |
| **Build provenance (desktop)** | `actions/attest-build-provenance`      | Signed provenance for every installer in `dist/installers`.                          |
| **Build provenance (image)**   | `actions/attest-build-provenance`      | Signed provenance for the GHCR image, pushed alongside it.                           |
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
```

---

## One-time maintainer setup

These cannot be committed to the repo — enable them in the GitHub UI / CLI.

### 1. Branch protection on `main`

#### Currently observed live rules

The repository rulesets were inspected on 2026-07-16. **Main protection with
release-bot bypass** requires the `validate` status check and one approving
review and dismisses stale reviews. **Copilot review for default branch** owns
the deletion and non-fast-forward protections. Conversation resolution, Code
Owner review, and approval of the most recent push were not enabled. This is an
observed-state record, not evidence that the settings are enforced by files in
this repository.

#### Deferred administrative follow-up

After this branch lands and GitHub has created the new check context, update the
status-check ruleset to require `merge-gate` (replacing the narrower `validate`
requirement), keep branches up to date, and enable conversation resolution.
Consider Code Owner review, last-push approval, and signed commits according to
the maintainer policy. This repository change deliberately does not mutate live
GitHub administration.

`npm run validate` is the coverage-aware local shipping gate. `merge-gate` is
the single complete CI verdict: it fails unless `validate`, the shipped
self-hosted Node image build plus API/SPA smoke, the docs build, web and Electron
E2E, browser and VS Code extension E2E, and every cross-OS Electron packaging
smoke job succeed. The only permitted skips are the documented native jobs on
Dependabot pull requests. Do **not** require `Deploy preview`, which is
intentionally absent for forked pull requests.

Keep the **Main protection with release-bot bypass** ruleset's pull-request-only
bypass restricted to the `restura-bot` GitHub App. Do not recreate a legacy
branch-protection rule for `main`: personal repositories cannot scope that
rule's review bypass to an App, and `github-actions[bot]` must not receive a
bypass.

> The stable Release workflow validates `main`, then creates a dedicated
> version-only `release/prepare` PR with the `restura-bot` GitHub App token and
> immediately merges it through the App's pull-request bypass. It does not wait
> for candidate-PR CI, because the candidate contains only the validated version
> manifests. This avoids GitHub's generic auto-merge executor, which cannot use
> an App's review bypass. Publication still waits for a successful `merge-gate`
> check run attached to the exact candidate SHA produced by that merge.
> Do not add a bypass for `github-actions[bot]`.

### 2. Code scanning (CodeQL)

CodeQL runs via GitHub **default setup** (enabled in **Settings → Code security
→ Code scanning**), not a committed workflow. Default setup and an advanced
`codeql.yml` are mutually exclusive — enabling both makes the advanced run fail
to upload (`analyses from advanced configurations cannot be processed when the
default setup is enabled`), which is why there is no `codeql.yml` here.

- To broaden coverage, edit default setup and switch the query suite to
  **`security-extended`** and/or add the **`actions`** language.
- To switch to an advanced workflow instead (e.g. for `security-extended` +
  `actions` + a weekly schedule in code), first **disable default setup**, then
  add a `codeql.yml`. Don't run both.

### 3. Secret scanning + push protection

**Settings → Code security:**

- ✅ **Secret scanning** — on.
- ✅ **Push protection** — on (blocks commits that contain a recognized secret).
- ✅ **Validity checks** (where available).

### 4. Dependabot auto-merge

Patch & minor dependency updates from Dependabot are queued for auto-merge by
`dependabot-auto-merge.yml`; GitHub merges them once the required status checks
(step 1) go green. Major bumps and non-semver updates are left for manual review.

To make it work:

- ✅ **Settings → General → Pull Requests → "Allow auto-merge"** — on. Without
  this, `gh pr merge --auto` errors and nothing merges.
- ✅ **Branch protection with required status checks** (step 1). `--auto` waits
  on _required_ checks only; a red required check holds the merge.
- **Approvals.** The workflow does **not** self-approve — the default
  `GITHUB_TOKEN` (`github-actions[bot]`) is not permitted to approve PRs, and
  trying to do so fails with _"GitHub Actions is not permitted to approve pull
  requests. (addPullRequestReview)"_. So if `main` has a "require N approvals"
  (or Code Owner review) rule, an auto-merge-enabled Dependabot PR will sit
  un-merged until a human approves it. To get true hands-off merging, **exempt
  Dependabot patch/minor PRs from the approval requirement** — e.g. a branch
  ruleset whose bypass list / target conditions exclude `dependabot[bot]` PRs —
  or keep approving them by hand. (If you'd rather keep the required-approval
  rule enforced for bots too, restore the approve step but authenticate it with
  a PAT or GitHub App token — a real user identity — instead of `GITHUB_TOKEN`.)

How Dependabot runs are hardened (in `ci.yml`):

- **`--ignore-scripts`** on every `npm ci` — the updated package's lifecycle
  scripts never execute in the merge-gating jobs. (Dependabot runs also get a
  read-only token and no secrets by default.)
- **Native Electron jobs are skipped on Dependabot pull requests** — they need the
  `electron-builder install-app-deps` postinstall that `--ignore-scripts`
  suppresses. The `merge-gate` evaluator permits only this explicit skip set;
  any other skipped, missing, cancelled, or failed dependency fails the gate.
  Electron dependency bumps still get desktop coverage at release preflight.
- **`deploy-preview` is skipped** — Dependabot has no Cloudflare secrets and a
  preview of a dep bump has no value.
- **PR test-result / coverage comments are skipped** — the read-only Dependabot
  token can't post them (would 403 and fail the job).

Tune the auto-merge scope (e.g. patch-only, or include `github-actions`) by
editing the `update-type` condition in `dependabot-auto-merge.yml`.

### 5. OpenSSF Scorecard

- No token needed for a **public** repo — `scorecard.yml` uses OIDC
  (`id-token: write`) and `publish_results: true`.
- The README badge (`api.securityscorecards.dev/...`) resolves after the first
  scheduled/`main` run completes.
- Scorecard will score higher once branch protection (step 1) is in place.

### 6. Release secrets

The Release **preflight** job fails fast if a stable release is missing any of
these. Set them in **Settings → Secrets and variables → Actions**:

| Secret                                                     | Required for            | Notes                                                   |
| ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `NPM_TOKEN`                                                | npm CLI publish         | Automation token; publish to public npm.                |
| `CLOUDFLARE_API_TOKEN`                                     | web deploy              | Pages + Workers deploy scope.                           |
| `CLOUDFLARE_ACCOUNT_ID`                                    | web deploy              |                                                         |
| `WORKER_PROXY_TOKEN`                                       | web build/deploy        | Injected into the production build + Worker auth gate.  |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | macOS signing           | Required for stable releases; base64 `.p12` + password. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization      | Required for stable releases.                           |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                     | Windows signing         | Optional until a Windows certificate is available.      |
| `SENTRY_DSN`                                               | desktop crash reporting | Required for stable releases; public ingest id.         |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`        | source-map upload       | Required for stable releases; symbolicated stacks.      |

> `GITHUB_TOKEN` is automatic. `GHCR` publish uses it (`packages: write`).

The **extension** release workflows use a separate set of secrets. They are all
optional — each publish step self-skips when its secrets are absent, so a tagged
run still builds, packages, and attaches the artifact to a GitHub release:

| Secret                                                                                    | Required for        | Notes                                           |
| ----------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------- |
| `VSCE_PAT`                                                                                | VS Code Marketplace | Azure DevOps PAT, Marketplace **Manage** scope. |
| `OVSX_PAT`                                                                                | Open VSX (optional) | Open VSX access token.                          |
| `CHROME_EXTENSION_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` | Chrome Web Store    | OAuth2 creds; see the extension runbook.        |

> Full step-by-step in the [extension release runbook](./EXTENSION_RELEASE.md).

### 7. (Optional) Protected production environment

For an extra approval gate on the production Cloudflare deploy, create a
**Settings → Environments → `production`** environment with **required
reviewers**, then add `environment: production` to the `deploy-web` job in
`release.yml`. The job will then pause for manual approval before deploying.

### 8. OpenWiki documentation updates

`openwiki-update.yml` runs [OpenWiki](https://github.com/langchain-ai/openwiki)
daily to keep `openwiki/` — the machine-readable docs coding agents reference —
in sync with recent commits. It opens a PR rather than pushing directly.

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
  `openwiki/` directory — the daily job only handles incremental `--update`
  diffs.

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
   does not wait for candidate-PR CI. The merged PR starts a publish workflow,
   but preflight accepts `merge-gate` only from this repository's CI workflow
   run on a `main` push for the exact candidate SHA. The workflow propagates that
   immutable merge commit through every checkout, so later `main` commits are
   excluded.
4. The publish run: **preflight** (exact-SHA CI proof + build surfaces) → **release**
   (tag, notes, SBOM, draft release) → fan-out (**desktop**, **publish-cli**,
   **publish-docker**, **deploy-web**) → **publish-release** (flips the draft to
   public once every required downstream job succeeds).
5. Verify the published artifacts with the `gh attestation verify` commands above.

### Recovery after a failed stable run

If a release fails before any external surface is published, the version-bump
commit remains on `main` but the GitHub release stays a **draft**. Delete the
draft and tag, then restart from the merged candidate:

```bash
gh release delete vX.Y.Z --cleanup-tag --yes   # drop draft + tag
gh workflow run release.yml --ref main \
  -f recover_stable_release_sha=<merged-release-candidate-sha>
```

If npm, Docker, or the web deployment already published and only the desktop
installers/updater metadata are missing, preserve that state and repair the
existing draft instead. This rebuilds desktop assets, validates the manifests,
and publishes the draft without republishing the other distribution surfaces:

```bash
gh workflow run release.yml --ref main -f repair_release_tag=vX.Y.Z
```

---

## Performance notes

- All `npm ci` steps run with `--prefer-offline --no-audit --no-fund` to skip
  the audit round-trip and prefer the restored npm cache.
- Playwright browsers are cached against `package-lock.json`; e2e runs in 2
  shards on separate runners.
- `setup-node` caches the npm download cache on every job.
- CodeQL and Scorecard run as standalone workflows in parallel with CI — they
  do not lengthen the CI critical path (they only gate merges if you mark them
  required in step 1).
