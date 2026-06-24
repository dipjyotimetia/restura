# CI/CD & Release Pipeline

This document describes Restura's continuous-integration and release pipeline,
the supply-chain security layers it ships with, and the **one-time repository
settings a maintainer must enable** to make the whole thing enforceable.

The workflow files themselves are the source of truth; this doc explains the
intent and the manual steps that can't live in a file (branch protection,
secret scanning, required reviewers, secrets).

---

## Workflows at a glance

| Workflow                  | File                                          | Trigger                                  | Purpose                                                                                                                                   |
| ------------------------- | --------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **CI**                    | `.github/workflows/ci.yml`                    | PR + push to `main`                      | Type-check, lint, format, codegen gates, unit/integration tests, build, bundle size, e2e (web + Electron), docs build, PR preview deploy. |
| **CodeQL**                | _GitHub default setup_ (no workflow file)     | PR + push to `main`, weekly              | SAST over `javascript-typescript`. Managed in **Settings → Code security → Code scanning**, not a committed workflow.                     |
| **Scorecard**             | `.github/workflows/scorecard.yml`             | push to `main`, weekly, branch-prot edit | OpenSSF supply-chain posture score + badge.                                                                                               |
| **Dependency Review**     | `.github/workflows/dependency-review.yml`     | PR                                       | Blocks PRs that add high-severity-vulnerable or disallowed-license deps.                                                                  |
| **Security Audit**        | `.github/workflows/security-audit.yml`        | weekly, manual                           | Non-blocking `npm audit --audit-level=critical` (visibility net; Dependabot is the fix path).                                             |
| **Dependabot auto-merge** | `.github/workflows/dependabot-auto-merge.yml` | PR (Dependabot only)                     | Approves + enables auto-merge for patch/minor dependency updates once required checks pass.                                               |
| **Release**               | `.github/workflows/release.yml`               | **manual** (`workflow_dispatch`)         | Versioned, attested release: tag → notes → SBOM → desktop installers → npm CLI → Docker → Cloudflare.                                     |

> Releases are **never** cut on merge to `main`. Production ships only from a
> manually-dispatched **Release** run. See the runbook below.

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

**Settings → Branches → Add branch ruleset** (or classic _Branch protection
rules_) for `main`:

- ✅ **Require a pull request before merging** (≥ 1 approval; _Require review
  from Code Owners_ — `CODEOWNERS` already routes to `@dipjyotimetia`).
- ✅ **Require status checks to pass before merging** + **Require branches to be
  up to date**. Select these checks (names must match exactly — these are the
  job `name:` values that run on **pull requests**):

  | Required check                          | From              |
  | --------------------------------------- | ----------------- |
  | `Type-check, lint, test, build`         | CI / `validate`   |
  | `Docs site (type-check + build)`        | CI / `docs`       |
  | `Review dependency changes`             | Dependency Review |
  | `CodeQL` (the default-setup check name) | Code scanning     |

  Recommended-but-heavier (enable once you're comfortable with their runtime /
  flakiness budget):

  | Optional check                                          | From                  |
  | ------------------------------------------------------- | --------------------- |
  | `Playwright E2E (shard 1/2)` + `2/2`                    | CI / `e2e`            |
  | `Electron desktop E2E`                                  | CI / `e2e-electron`   |
  | `Electron pack smoke (ubuntu-latest)` (+ macos/windows) | CI / `electron-smoke` |

  > Do **not** require `Deploy preview` — it is skipped on forked PRs by design,
  > and a required check that never runs blocks the merge.

- ✅ **Require conversation resolution before merging.**
- ✅ **Do not allow bypassing the above settings** (or scope an explicit bypass
  list). Allow the `github-actions[bot]` actor only if you keep the release
  bump-commit push to `main` (the Release workflow pushes `chore(release): vX.Y.Z`).
- ✅ **Require signed commits** (optional, recommended).
- ⛔ Block force-pushes and deletions of `main`.

> The Release workflow's `Commit, tag, push` step pushes the version bump to
> `main`. If you enable "require PR" / "require signed commits" without a bypass
> for `github-actions[bot]`, that push will be rejected and stable releases will
> fail at the push step. Add a ruleset bypass for the Actions bot, or convert the
> release to open a PR instead of pushing directly.

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

Patch & minor dependency updates from Dependabot are approved and queued for
auto-merge by `dependabot-auto-merge.yml`; GitHub merges them once the required
status checks (step 1) go green. Major bumps and non-semver updates are left for
manual review.

To make it work:

- ✅ **Settings → General → Pull Requests → "Allow auto-merge"** — on. Without
  this, `gh pr merge --auto` errors and nothing merges.
- ✅ **Branch protection with required status checks** (step 1). `--auto` waits
  on _required_ checks only; a red required check holds the merge.
- **Approvals.** The workflow self-approves so a generic "require N approvals"
  rule is satisfied. If you require **Code Owner** review specifically, a bot
  approval does _not_ count — either drop the code-owner requirement for the
  auto-merge to complete, or keep approving Dependabot PRs by hand.

How Dependabot runs are hardened (in `ci.yml`):

- **`--ignore-scripts`** on every `npm ci` — the updated package's lifecycle
  scripts never execute in the merge-gating jobs. (Dependabot runs also get a
  read-only token and no secrets by default.)
- **`electron-smoke` and `e2e-electron` are skipped** — they need the
  `electron-builder install-app-deps` postinstall that `--ignore-scripts`
  suppresses. They aren't required checks, so skipping never blocks the merge;
  Electron dep bumps still get desktop coverage at release preflight.
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

| Secret                                                     | Required for                       | Notes                                                  |
| ---------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `NPM_TOKEN`                                                | npm CLI publish                    | Automation token; publish to public npm.               |
| `CLOUDFLARE_API_TOKEN`                                     | web deploy                         | Pages + Workers deploy scope.                          |
| `CLOUDFLARE_ACCOUNT_ID`                                    | web deploy                         |                                                        |
| `WORKER_PROXY_TOKEN`                                       | web build/deploy                   | Injected into the production build + Worker auth gate. |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                             | macOS signing (optional)           | base64 `.p12` + password.                              |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization (optional)      |                                                        |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                     | Windows signing (optional)         | base64 `.pfx` + password.                              |
| `SENTRY_DSN`                                               | desktop crash reporting (optional) | Public ingest id; absent → Sentry disabled.            |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`        | source-map upload (optional)       | symbolicated crash stacks.                             |

> `GITHUB_TOKEN` is automatic. `GHCR` publish uses it (`packages: write`).

### 7. (Optional) Protected production environment

For an extra approval gate on the production Cloudflare deploy, create a
**Settings → Environments → `production`** environment with **required
reviewers**, then add `environment: production` to the `deploy-web` job in
`release.yml`. The job will then pause for manual approval before deploying.

---

## Release runbook

1. Ensure `main` is green and carries everything you want to ship.
2. **Actions → Release → Run workflow** (on `main`), or:
   ```bash
   gh workflow run release.yml --ref main \
     -f release_bump=patch        # patch | minor | major
     # -f prerelease=true -f prerelease_identifier=beta.1   # for a beta
     # -f publish_docker=true                               # opt in to GHCR
   ```
3. The run: **preflight** (validate + build surfaces) → **release** (bump, tag,
   notes, SBOM, draft release) → fan-out (**desktop**, **publish-cli**,
   **publish-docker**, **deploy-web**) → **publish-release** (flips the draft to
   public once every required downstream job succeeds).
4. Verify the published artifacts with the `gh attestation verify` commands above.

### Recovery after a failed stable run

The bump commit + tag are pushed to `main` **before** the build/publish/deploy
jobs. If a downstream job fails, the GitHub release stays a **draft** while
`main` already carries the bump + tag. To retry:

```bash
gh release delete vX.Y.Z --cleanup-tag --yes   # drop draft + tag
git revert <bump-commit>                        # only if abandoning the version
# then re-dispatch the Release workflow
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
