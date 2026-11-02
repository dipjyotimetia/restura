# Supply-chain hardening

How Restura protects its releases, and the people who install them, from
supply-chain attacks: which controls exist, which account settings back them,
what was deliberately left out, and what to do when something is compromised.

[`CI_CD.md`](./CI_CD.md) explains each workflow and the one-time repository
settings in detail; this page is the threat-oriented summary, the incident
runbook and the review cadence. Users who want to check a download should read
[`SECURITY.md` → Verifying downloads](../SECURITY.md#verifying-downloads).

Tracking epic: [#1283](https://github.com/dipjyotimetia/restura/issues/1283).

---

## 1. Threat model

Restura ships six artifacts: the web app (Cloudflare Pages + Worker), the GHCR
Docker image, signed desktop installers, the `restura-cli` npm package, and the
VS Code and Chrome extensions. An attacker wants their code inside one of them,
or the credential that publishes it.

| # | Attack path | Example | Defences in place |
|---|---|---|---|
| A1 | Malicious dependency version | A compromised upstream release adds an install script that steals CI secrets | Dependabot cooldowns; `--ignore-scripts` on every CI/release install; `allowScripts` decisions enforced by `lockfile:check`; `npm audit signatures`; registry-only lockfile sources; dependency intake checklist |
| A2 | Stolen publish credential | `NPM_TOKEN` used from a laptop to publish `restura-cli` | npm trusted publishing (no npm token exists); marketplace tokens only in the `extensions` environment, never next to dependency code |
| A3 | Maintainer account takeover | A phished session pushes to `main` or edits a workflow | Phishing-resistant 2FA, rulesets, signed commits (account settings, §3) |
| A4 | Workflow abuse | Script injection via a PR title, a moved tag, cache poisoning | SHA-pinned actions; zizmor + CodeQL; `persist-credentials: false`; job-scoped write permissions; no dependency caches in release jobs |
| A5 | Tampering with a signed build | An install script rewrites `electron-builder` before signing | Install scripts off in the signing job; provenance minted in jobs that run no npm code |
| A6 | AI-agent abuse | Prompt injection in an issue body; a poisoned imported skill | Agent workflow rule and table ([CI_CD.md → AI-agent workflows](./CI_CD.md#ai-agent-workflows)); `skills:check` |
| A7 | Users can't verify releases | A lookalike site serves an unsigned installer | SLSA provenance, npm provenance, SBOM, and published verification steps |

---

## 2. Controls in the repository

Each control is enforced by a committed file, so a change to it goes through
review like any other code.

### Dependencies and install scripts

- **Dependency install scripts don't run in CI or release jobs.** Every
  install of the repo's dependencies passes `--ignore-scripts`. A job that
  needs a binary from an approved package rebuilds just that package
  (`npm rebuild @sentry/cli electron-winstaller` in the desktop release,
  `npm rebuild @vscode/vsce-sign` when packaging the VS Code extension).
  Electron downloads its binary lazily on first launch, and electron-builder
  rebuilds native modules itself. Pinned CI tools under `.github/tools/`
  install with their own `allowScripts` decisions. Today only two scripts are
  approved: the Claude Code binary for evals, and `@vscode/vsce-sign`, which
  copies its platform binary in the VS Code publish job.
- **Build-time code still runs.** `--ignore-scripts` stops install scripts,
  not the code a build or test executes. Jobs that hold a secret therefore
  avoid running repo dependencies at all where possible. Release secret
  presence is checked in `release-secrets` (no checkout, no npm), not in
  `preflight`, which runs `npm run validate`. The one exception is `desktop`,
  which still builds and signs in one job (§4).
- **Every install script has a reviewed decision.** npm 12 (pinned by
  `scripts/verify-toolchain.mjs`) skips any dependency install script that
  isn't approved in the `allowScripts` field of `package.json`, but only
  warns. `npm run lockfile:check` (`scripts/check-lockfile-policy.mjs`, part
  of `validate:static`) fails when a lockfile entry with an install script has
  no `allowScripts` decision (`true` or `false`). A dependency bump that adds
  an install script therefore needs a reviewed `package.json` change. The
  check covers the root, `docs-site/` and every `.github/tools/*` lockfile.
- **Registry-only, hash-pinned lockfiles.** The same check fails on any
  lockfile entry that doesn't resolve from `https://registry.npmjs.org/` or
  has no `integrity` hash (git URLs, tarball URLs). Bundled dependencies are
  covered by their parent's hash.
- **Registry signatures.** `npm audit signatures` runs after install in
  `validate-static-build` and in every release job that installs dependencies.
- **Pinned CI tools.** Tools that run in CI or release jobs (Claude Code,
  OpenWiki, the CycloneDX SBOM generator, the marketplace publishers) install
  from lockfiles under `.github/tools/`, never from a floating `npx` download.

### Publishing and signing

- **npm trusted publishing.** `restura-cli` is built and packed in `build-cli`,
  which has no OIDC permission. It is then published from `publish-cli`, which
  holds `id-token: write` but installs nothing: it downloads the tarball and
  runs `npm publish`. npm exchanges the job's OIDC token for a short-lived
  publish token and attaches provenance. No `NPM_TOKEN` exists.
- **Provenance away from dependency code.** `desktop` builds and signs the
  installers without `id-token`. `attest-desktop` attests the uploaded
  installers with no checkout and no npm. It downloads each desktop leg's
  artifact by its exact name, never by pattern, so an artifact another job
  uploads can't be merged in and attested. `publish-docker` pushes the image,
  and `attest-image` attests its digest. npm, GHCR and Cloudflare publishing
  wait for `attest-desktop`, and `publish-release` never publishes a release
  whose attestations failed.
- **Marketplace tokens.** Each extension workflow is split into a packaging
  job, which runs `npm ci` but has no secrets, and a publish job. The publish
  job runs in the `extensions` environment and installs only
  `.github/tools/publish`.
- **The restura-bot App token** is minted only after `prepare-stable` has
  installed dependencies. It is scoped to `contents` and `pull-requests`, and
  is never written into `.git/config`.

### Workflows

- **Least privilege.** Every workflow is read-only at the top level; write
  scopes are granted per job. Every `actions/checkout` sets
  `persist-credentials: false`, except the `release` job. That job pushes the
  tag and runs no npm-installed code; the SBOM is generated in a separate
  read-only `sbom` job and handed over as an artifact.
- **No dependency caches in release, signing or extension jobs.**
  `setup-node-npm` with `cache: ''` also turns off `setup-node`'s automatic npm
  cache, which `packageManager` in `package.json` would otherwise enable. The
  release Docker image is built without the GitHub Actions layer cache.
- **zizmor** (`.github/workflows/workflow-lint.yml`) lints `.github/` on every
  change and weekly. Findings at medium severity and above fail the check, and
  every suppression is inline with a reason.
- **All third-party actions are pinned to a commit SHA.** Dependabot bumps them
  after a 7-day cooldown.

### AI agents

- No agent workflow that reads untrusted input holds a token that can push to
  `main`, publish, deploy or read release secrets. Each agent workflow's
  triggers, token and tools are listed in
  [CI_CD.md → AI-agent workflows](./CI_CD.md#ai-agent-workflows).
- `npm run skills:check` (`scripts/check-skills-lock.mjs`, part of
  `validate:static`) fails when an imported skill under `.agents/skills/`
  doesn't match the `computedHash` recorded in `skills-lock.json`. Review the
  upstream diff before updating the lock.
- Agent configuration (`.claude/`, `.agents/`, `AGENTS.md`, `CLAUDE.md`) is a
  sensitive path in `.github/CODEOWNERS`; review hook and skill changes like CI
  changes.

---

## 3. Account and repository settings

These can't be committed. The maintainer applies them; each has its own issue.

| Setting | Issue | When |
|---|---|---|
| npmjs.com → `restura-cli` → *Trusted publishing*: GitHub Actions, `dipjyotimetia/restura`, workflow `release.yml` (no environment) | [#1287](https://github.com/dipjyotimetia/restura/issues/1287) | **Before** the first stable release on the new workflow; otherwise `publish-cli` gets 403/404 |
| npmjs.com → `restura-cli` → *Require 2FA and disallow tokens*; revoke and delete `NPM_TOKEN` | #1287 | After one successful trusted publish |
| Settings → Environments → `extensions`: deployment rule *tags* `vscode-v*` and `chrome-v*`; move `VSCE_PAT`, `OVSX_PAT`, `CHROME_*` into it | [#1286](https://github.com/dipjyotimetia/restura/issues/1286), [#1288](https://github.com/dipjyotimetia/restura/issues/1288) | Any time. Until the secrets move, the publish jobs still read the repo-level copies |
| Phishing-resistant 2FA on GitHub, npm, Cloudflare, Apple, marketplaces, Google, Sentry | [#1284](https://github.com/dipjyotimetia/restura/issues/1284) | Now |
| Private credential inventory, scope and expiry for every release secret | [#1285](https://github.com/dipjyotimetia/restura/issues/1285) | Now, then quarterly |
| `v*` tag ruleset, signed commits on `main`, fork-PR approval, default read-only token, allowed-actions list (add `zizmorcore`) | [#1289](https://github.com/dipjyotimetia/restura/issues/1289) | After this lands. Tags are pushed by **GitHub Actions** (`GITHUB_TOKEN`), and a retry deletes an unpublished tag, so the bypass must cover GitHub Actions |
| CodeQL default setup: add the `actions` language and the `security-extended` suite | [#1295](https://github.com/dipjyotimetia/restura/issues/1295) | Any time |
| Make the `zizmor` check required on `main` | [#1296](https://github.com/dipjyotimetia/restura/issues/1296) | Once its first run is clean |

---

## 4. Deliberately not done (yet)

- **A ref-locked `release` environment for `release.yml`** (part of #1286).
  The stable publish run is triggered by the merged `release/prepare` PR
  (`pull_request: closed`). Its `GITHUB_REF` is therefore
  `refs/pull/<n>/merge`, not `refs/heads/main`. A `main`/`v*` deployment rule
  would refuse it, and allowing `refs/pull/*/merge` would let any same-repo
  PR's copy of the workflow read the secrets. This needs the publish run to
  move to a `push` (or bot-dispatched) trigger first, which is a release-flow
  change of its own. Until then the release secrets stay repository secrets,
  read only by the release jobs that need them.
- **Runner egress blocking (harden-runner, #1294).** Blocking requires weeks of
  observed endpoints per job, and the action sends job telemetry to a third
  party. Revisit once the install-script controls above have settled.
- **Separating desktop signing from the build (#1301).** Install scripts are
  now off in the signing job, which removes the most common payload (A5).
  Build-time code from dependencies (Vite plugins, electron-builder) still runs
  in the same job as the signing certificate and Apple credentials. A separate
  signing job needs electron-builder's `--prepackaged` flow or cloud signing,
  and should be recorded as an ADR when it's done.
- **A second code owner (#1302).** This needs a second trusted maintainer. The
  sensitive-path block in `CODEOWNERS` is ready for one.

---

## 5. Incident runbook

Keep this short enough to follow under stress.

### 5.1 A dependency we use is reported compromised

1. Check whether the bad version was ever installed:
   `git log -p -S '"node_modules/<pkg>"' -- package-lock.json` and `npm ls <pkg>`.
2. If it was never in a lockfile, pin or override it away from the bad range
   (see the `dependabot-remediate` skill) and stop.
3. If CI or a release job installed it, check whether its install script could
   have run. It couldn't if it has no `allowScripts: true` entry, because CI
   installs with `--ignore-scripts`. Its code could still have run during a
   build or test, so treat every secret that job could reach as leaked.
   Rotate in this order: Cloudflare token, restura-bot App key, signing
   certificates (revoke with Apple or the CA if a key file was reachable),
   marketplace tokens, Sentry token.
4. If it reached a shipped artifact, go to §5.3.

### 5.2 A credential leaked or an unexpected publish happened

1. Revoke the credential at its source first (npm, Cloudflare, GitHub App, PAT,
   marketplace). A replacement takes minutes to issue.
2. npm: `npm deprecate restura-cli@<bad> "compromised, do not use"`, then ask
   npm support to remove the version (self-service unpublish works within 72
   hours if nothing depends on it).
3. Review the audit logs: GitHub (Settings → Security log), npm account
   activity, Cloudflare audit logs.
4. Re-check 2FA on the account that leaked (#1284).

### 5.3 A shipped release is bad

1. Mark the GitHub release as a pre-release, add a warning to its notes, and
   delete its assets.
2. Deprecate the npm version. Delete the GHCR tag but keep the digest for
   forensics. Roll back the Cloudflare deployment (Pages → Deployments →
   *Rollback*; `wrangler rollback` for the Worker). Unpublish or roll back the
   extensions.
3. Publish a GitHub Security Advisory with the affected versions and the
   verification steps from [`SECURITY.md`](../SECURITY.md#verifying-downloads),
   so users can tell clean installs from bad ones.
4. Rotate credentials, then cut a clean patch release from a known-good commit.
5. Write up what happened in `docs/audits/` and add the missing control here.

---

## 6. Review cadence

| When | What |
|---|---|
| Every PR | Dependency intake checklist ([CONTRIBUTING.md → Adding a dependency](../CONTRIBUTING.md#adding-a-dependency)) for new direct dependencies; skim the lockfile diff; zizmor output on workflow changes |
| Weekly (`triage-maintenance` sweep) | Security Audit run, Scorecard changes, open Dependabot and code-scanning alerts (including `zizmor` and CodeQL `actions`), `npm install-scripts ls` shows nothing unreviewed |
| Monthly | `allowScripts` entries still match the lockfile (`npm install-scripts prune --dry-run`); allowed-actions list matches the workflows; unused credentials removed |
| Quarterly | Rotate the long-lived tokens that remain (Cloudflare, marketplaces, Sentry); review GitHub Apps, OAuth apps, collaborators and deploy keys; check 2FA on every account in #1284 |
| Yearly | Signing certificate expiry dates; re-read this page and the threat model |
