# Supply-chain hardening guideline

How to protect Restura, and the people who install it, from supply-chain attacks.
This is the plan: what to change, in what order, how to check each step worked, and
what to do if something is compromised.

[`CI_CD.md`](./CI_CD.md) describes the controls that already exist (the
*Supply-chain security layers* table and *One-time maintainer setup*). This doc
does not repeat them; it covers the gaps and links back where a step extends an
existing control.

Each task is tagged with where the change happens:

- **[repo]**: a committed change (workflow, config, script). Goes through a PR.
- **[settings]**: GitHub, npm, Cloudflare or another account's UI. Cannot be committed.

---

## 1. Threat model

Restura ships four artifacts: the web app (Cloudflare Pages + Worker), the Docker
image on GHCR, signed desktop installers, and the `restura-cli` npm package, plus the
VS Code and Chrome extensions. An attacker wants their code inside one of those, or
wants the credentials that publish them.

| # | Attack path | Example | Main defence |
|---|---|---|---|
| A1 | **Malicious dependency version.** A maintainer account upstream is taken over and a poisoned release is published. | A compromised npm package adds an install script that steals CI secrets. | Dependabot cooldown (exists), install-script allowlist (§4.2), egress blocking (§4.3), keeping third-party code away from secrets (§4.1) |
| A2 | **Stolen publish credential.** A long-lived token leaks and is used to publish outside CI. | `NPM_TOKEN` is used from a laptop to push `restura-cli@x.y.z+1`. | Trusted publishing (§3.1), protected environments (§3.2), token inventory (§2.3) |
| A3 | **Maintainer account takeover.** | A phished GitHub session pushes to `main` or edits a workflow. | Phishing-resistant 2FA (§2.1), rulesets (§2.4) |
| A4 | **Workflow abuse.** Script injection, `pull_request_target` misuse, a moved action tag, cache poisoning. | A PR title containing `$(curl …)` is interpolated into `run:`. | SHA pinning (exists), zizmor and CodeQL `actions` (§5.1), least-privilege tokens (§4.4) |
| A5 | **Build-time tampering of a signed artifact.** Third-party code runs in the same job as signing or OIDC. | An esbuild postinstall rewrites `electron-builder` so the signed `.dmg` contains a backdoor. | Job split (§4.1) |
| A6 | **AI-agent abuse.** Prompt injection into the Claude workflows, or a poisoned third-party skill or MCP server. | An issue body tells the agent to add a dependency or exfiltrate a token. | §7 |
| A7 | **Consumers can't tell a real release from a fake one.** | A lookalike download site serves an unsigned installer. | Published verification steps (§8) |

---

## 2. Phase 0: accounts and access (do first, ~1 hour, all [settings])

Most of the repo's controls can be bypassed by whoever controls the maintainer
account, so start there.

### 2.1 Phishing-resistant 2FA everywhere

- **GitHub:** Settings → Password and authentication. Register at least two passkeys
  or hardware security keys (one kept offline as a backup). Remove SMS as a 2FA
  method. Store recovery codes offline.
- **npm:** npmjs.com → Account → Two-Factor Authentication → *Authorization and
  writes*, using a security key.
- **Cloudflare, Apple Developer, Microsoft Partner Center / Azure DevOps (VS Code
  Marketplace), Chrome Web Store, Sentry:** turn on security-key 2FA for each.
  Every one of these can publish or alter something users run.
- Use a password manager; do not reuse passwords across these accounts.

**Check:** sign in to each account from a private window; it must ask for the key.

### 2.2 npm package settings

For `restura-cli` on npmjs.com → package → Settings → *Publishing access*: choose
**Require two-factor authentication and disallow tokens** once trusted publishing
(§3.1) works. Until then, keep "Require 2FA or an automation or granular token".

### 2.3 Credential inventory and rotation

Keep a private list (not in this repo) of every credential that can publish or
deploy, with owner, scope, expiry and last rotation. Today that means:

| Credential | Lives in | Can do | Target state |
|---|---|---|---|
| `NPM_TOKEN` | Actions secret | Publish `restura-cli` | **Delete** after §3.1 |
| `CLOUDFLARE_API_TOKEN` | Actions secret | Deploy Pages + Workers | Custom token, only *Pages: Edit* and *Workers Scripts: Edit* on this account; client IP filtering if you have stable runner IPs; 90-day expiry; move to the `release` environment |
| `CSC_LINK` / `CSC_KEY_PASSWORD`, `WIN_CSC_*` | Actions secret | Sign desktop builds | Move to the `release` environment; long term, sign with a cloud key service so no key file leaves it (§4.1) |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` | Actions secret | Notarize | App-specific password used only for this; or switch to an App Store Connect API key (`APPLE_API_KEY`) with the *Developer* role |
| `RELEASE_PR_APP_PRIVATE_KEY` (restura-bot) | Actions secret | Ruleset bypass for release PRs | Move to the `release` environment; App installed on this repo only; minimal App permissions |
| `VSCE_PAT`, `OVSX_PAT` | Actions secret | Publish VS Code extension | Shortest expiry the portal allows, scope *Marketplace → Manage* only; move to an `extensions` environment |
| `CHROME_*` OAuth refresh token | Actions secret | Publish Chrome extension | Move to the `extensions` environment; dedicated Google account with security-key 2FA |
| `SENTRY_AUTH_TOKEN` | Actions secret | Upload source maps | Org token scoped to `project:releases` only |
| `OPENROUTER_API_KEY` | Actions secret | Spend money | Spend limit on the provider side |
| Personal access tokens on your GitHub account | github.com → Developer settings | Anything you can do | Delete unused ones; fine-grained PATs only, repo-scoped, with an expiry |

Also review **Settings → Integrations → GitHub Apps** and **Settings → Deploy keys**,
and **github.com → Settings → Applications** (OAuth apps with access to your account).
Revoke anything unused.

**Check:** every row has an expiry or a reason it can't have one, and nothing on the
list is unused.

### 2.4 Repository rulesets

[`CI_CD.md` §1](./CI_CD.md#1-branch-protection-on-main) defines the `main` ruleset.
Add on top:

- **Tag ruleset for `v*`** (Settings → Rules → Rulesets → New tag ruleset): restrict
  creation, update and deletion to the `restura-bot` App. Release tags must never be
  moved; `gh attestation verify` and users' pinned versions depend on it.
- **Require signed commits** on `main` (currently "optional, recommended"). Set up
  SSH or GPG commit signing locally first.
- **Settings → Actions → General:**
  - *Fork pull request workflows from outside collaborators* → **Require approval for
    all outside collaborators**.
  - *Workflow permissions* → **Read repository contents** as the default
    `GITHUB_TOKEN` permission. Every workflow already sets `permissions:` explicitly,
    so this only catches a future workflow that forgets.
  - *Allow actions and reusable workflows* → **Allow select actions**, listing the
    owners actually used (`actions/*`, `github/*`, `aquasecurity/*`,
    `anthropics/*`, `peter-evans/*`, `dependabot/*`, `ossf/*`,
    `step-security/*` once §4.3 lands, and so on). Regenerate the list with:
    ```bash
    grep -rhoE 'uses:\s*[^./][^@ ]+' .github | sed 's/uses:\s*//; s#/.*##' | sort -u
    ```
- **Settings → Code security:** turn on *Private vulnerability reporting* so reports
  come in privately. `SECURITY.md` already links to the private advisory form, so
  confirm the setting is on or that link fails.

**Second reviewer.** With one maintainer, a single compromised account can approve
its own changes. When a trusted contributor is available, add them in `CODEOWNERS`
for `/.github/`, `/package-lock.json`, `/package.json`, `/electron-builder.json`,
`/shared/protocol/` and `/electron/main/security/`. That makes the account-takeover
path (A3) need two people.

---

## 3. Phase 1: publishing credentials (highest impact, [repo] + [settings])

### 3.1 npm trusted publishing for `restura-cli`

**Why:** `publish-cli` in `release.yml` authenticates with the long-lived
`NPM_TOKEN`. Anyone holding that token can publish from anywhere (A2). Trusted
publishing replaces it with a short-lived OIDC token that only this workflow, in
this repo, can obtain.

**Steps:**

1. **[settings]** npmjs.com → `restura-cli` → Settings → *Trusted publishing* → add a
   GitHub Actions publisher: owner `dipjyotimetia`, repository `restura`, workflow
   filename `release.yml`, environment `release` (after §3.2).
2. **[repo]** Split `publish-cli` into a build job and a publish job, so dependency
   code never runs in a job that can mint the publish token. Today `npm ci` and
   `npm run build -w cli` run in the same job that has `id-token: write`; any install
   script in that job can request the OIDC token. Sketch:

   ```yaml
   build-cli:
     name: Build restura-cli tarball
     needs: [release, desktop]
     if: ${{ needs.release.outputs.is_prerelease == 'false' }}
     runs-on: ubuntu-latest
     permissions:
       contents: read            # no id-token here
     steps:
       - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
         with:
           ref: ${{ needs.release.outputs.actual_tag }}
           persist-credentials: false
       - uses: ./.github/actions/setup-node-npm
         with: { node-version-file: '.nvmrc', cache: 'npm' }
       - run: npm ci --prefer-offline --no-audit --no-fund
       - run: npm run build -w cli
       - run: npm pack -w cli --pack-destination dist-npm
       - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
         with: { name: cli-tarball, path: dist-npm/*.tgz, if-no-files-found: error }

   publish-cli:
     name: Publish restura-cli to npm
     needs: [release, build-cli]
     runs-on: ubuntu-latest
     environment: release
     permissions:
       contents: read
       id-token: write           # trusted publishing + provenance
     steps:
       - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
         with:
           ref: ${{ needs.release.outputs.actual_tag }}
           persist-credentials: false
       - uses: ./.github/actions/setup-node-npm   # installs pinned npm only; no npm ci
         with: { node-version-file: '.nvmrc' }
       - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
         with: { name: cli-tarball, path: dist-npm }
       - name: Publish
         run: |
           set -euo pipefail
           NAME="$(node -p "require('./cli/package.json').name")"
           VERSION="$(node -p "require('./cli/package.json').version")"
           if npm view "${NAME}@${VERSION}" version >/dev/null 2>&1; then
             echo "${NAME}@${VERSION} already on npm, skipping."; exit 0
           fi
           npm publish dist-npm/*.tgz --access public
   ```

   Trusted publishing needs npm ≥ 11.5.1; the composite action already installs
   npm 12.1.0. Provenance is generated automatically with trusted publishing, so
   `--provenance` becomes redundant (harmless to keep).
3. Update `publish-release`'s `needs:` and the `preflight` secret check (it currently
   fails a stable release when `NPM_TOKEN` is missing). Update the secrets table in
   `CI_CD.md` §6.
4. After one successful release: **[settings]** delete `NPM_TOKEN` from Actions
   secrets, revoke it on npmjs.com, and switch the package to *disallow tokens* (§2.2).

**Check:**
```bash
npm view restura-cli --json | jq '.dist.attestations'
```
The new version shows a provenance attestation whose workflow is `release.yml` at the
release tag, and npmjs.com lists no access tokens for the account.

### 3.2 Protected `release` and `extensions` environments

**Why:** today every release secret is a repository secret, readable by any workflow
on any branch that references it. An environment with deployment rules only hands out
its secrets to approved runs from approved refs.

**Steps:**

1. **[settings]** Settings → Environments → **`release`**:
   - Required reviewers: you (plus the second maintainer when there is one).
     Untick *Prevent self-review* while you are the only maintainer, or you can't
     approve your own releases.
   - Deployment branches and tags: *Selected* → `main` and tag pattern `v*`.
   - Move these secrets from repository to environment level: `CSC_LINK`,
     `CSC_KEY_PASSWORD`, `WIN_CSC_*`, `APPLE_*`, `CLOUDFLARE_*`,
     `WORKER_PROXY_TOKEN`, `SENTRY_AUTH_TOKEN`, `RELEASE_PR_APP_*`.
2. **[settings]** Same for **`extensions`**: tag patterns used by the extension
   release workflows; secrets `VSCE_PAT`, `OVSX_PAT`, `CHROME_*`.
3. **[repo]** Add `environment: release` to each `release.yml` job that reads one
   of those secrets (`preflight`, `prepare-stable`, `desktop`, `publish-cli`,
   `deploy-web`) and `environment: extensions` to the publish jobs in
   `extension-*-release.yml`. This replaces the optional
   [`CI_CD.md` §7](./CI_CD.md#7-optional-protected-production-environment).
   A matrix job (`desktop`) asks for approval once per run, not once per OS.
4. **[repo]** Update `CI_CD.md` §6/§7 to say where each secret lives.

**Check:** run `release.yml` with `workflow_dispatch` from a scratch branch; it must
stop at "Waiting for review" and, if approved, still be refused by the branch rule.
`gh secret list` (repo level) should no longer show the release secrets.

### 3.3 Extension marketplaces

- VS Code Marketplace: check whether `vsce publish` with Microsoft Entra workload
  identity federation (`--azure-credential` with `azure/login` via OIDC) is
  available for the publisher. If it is, delete `VSCE_PAT`. If not, keep the PAT
  short-lived and in the `extensions` environment.
- Chrome Web Store: no OIDC option; keep the refresh token in the environment and on
  a dedicated account.

---

## 4. Phase 2: build integrity ([repo])

### 4.1 Keep third-party code away from signing keys and OIDC

**Why (A5):** in `release.yml` the `desktop` job runs `npm ci` (install scripts
included) and later signs with `CSC_LINK`, and holds `id-token: write` /
`attestations: write` for provenance. Step-level `env:` stops an install script from
reading the certificate directly, but it can change files in `node_modules` that the
signing step then runs (electron-builder, its native helpers) and it can request an
OIDC token for the whole job. `release-signing-check.yml` already documents this risk
for the weekly signing check.

**Steps, in order of effort:**

1. **Move attestation out of the build job.** Build and sign in `desktop`, upload
   the installers as artifacts, then attest them in a small job with
   `id-token: write` + `attestations: write` that runs no `npm` at all (checkout,
   download-artifact, `actions/attest-build-provenance`). Same for the GHCR image:
   attest from a job that only has the image digest. A compromised dependency then
   can't sign provenance for an artifact of its choosing.
2. **Install with `--ignore-scripts` in release jobs, then rebuild an allowlist**
   (see §4.2). This removes arbitrary install-time code from the signing job; only
   reviewed packages run their scripts.
3. **Longer term: remote signing.** Use a signing service that keeps the key
   (Azure Trusted Signing for Windows; for macOS, sign in a dedicated job that
   receives only the unsigned `.app` artifact and runs `codesign` / `notarytool`
   without `npm ci`). Then no job that ran third-party JavaScript ever holds a key.

**Check:** `grep -n 'npm ci' .github/workflows/release.yml` shows no `npm ci` without
`--ignore-scripts` in any job that has `id-token: write` or a signing secret.

### 4.2 Install-script allowlist

**Why (A1):** an install script is the usual payload in malicious npm releases, and
it runs before any test or review. CI already skips scripts on Dependabot PRs; extend
that to every install that doesn't need them, and approve the rest by name.

The lockfile currently marks these packages as having install scripts (regenerate
the list after any dependency change):

```bash
node -e 'const l=require("./package-lock.json");for(const[k,v]of Object.entries(l.packages))if(v.hasInstallScript)console.log(k||"(root)",v.version)'
```

Today that includes `esbuild`, `workerd`, `protobufjs`, `@sentry/cli`,
`electron-winstaller`, `@vscode/vsce-sign`, `fsevents`, plus the root package's own
`preinstall` / `postinstall` (`toolchain:check`, `electron-builder install-app-deps`).
`electron` downloads its binary from a postinstall too, even when the lockfile flag is
absent.

**Steps:**

1. Add a committed allowlist, e.g. `scripts/install-script-allowlist.json`, with the
   package names that may run scripts and why each one needs it.
2. Add a check script (run in `validate-static-build`) that fails when the lockfile
   gains a `hasInstallScript: true` entry that isn't on the allowlist. A new
   install script then needs a reviewed allowlist change, not just a lockfile bump.
3. In CI jobs that don't build native or desktop pieces (lint, type-check, unit
   tests, docs), switch to `npm ci --ignore-scripts` unconditionally, then
   `npm rebuild <allowlisted packages>` only where needed (`esbuild` for Vite builds,
   `workerd` for Miniflare).
4. Optional, for contributors: document `npm config set ignore-scripts true`
   followed by `npm rebuild esbuild workerd electron` in `CONTRIBUTING.md` for people
   who want the same protection locally.

**Check:** add a throwaway dependency with a `postinstall` in a test branch; the
allowlist check must fail.

### 4.3 Runner egress control

**Why:** most CI-secret theft ends with an HTTP request to an attacker's server.
Blocking unexpected outbound traffic stops that even if a malicious script runs.

**Steps:**

1. Add `step-security/harden-runner` (pinned by SHA) as the first step of every job
   in `release.yml`, `extension-*-release.yml` and `ci.yml`, with
   `egress-policy: audit`.
2. After two or three weeks of runs, read the reported endpoints and switch release
   jobs to `egress-policy: block` with an `allowed-endpoints` list (npm registry,
   GitHub, Apple notary, Cloudflare API, Sentry, Electron download mirror,
   GHCR). CI jobs can stay in audit mode if the list churns.
3. `harden-runner` doesn't support every runner OS in block mode; check its docs
   for macOS and Windows before relying on it for the `desktop` matrix.

### 4.4 Least-privilege tokens in workflows

Already good: actions are SHA-pinned and every workflow sets `permissions:`. Add:

- `persist-credentials: false` on every `actions/checkout` that doesn't push.
  `release.yml` currently has none, so `GITHUB_TOKEN` stays in `.git/config` where any
  later step (including dependency code) can read it.
- Job-level rather than workflow-level `permissions:` for write scopes, so only the
  job that needs `packages: write` or `contents: write` gets it.
- Keep `pull_request_target` limited to `dependabot-auto-merge.yml` and `merge-lane.yml`
  and keep their "never check out PR code" rules; zizmor (§5.1) enforces this.

### 4.5 Verify registry signatures on install

Add after `npm ci` in `validate-static-build` and in each release job:

```bash
npm audit signatures
```

It fails when an installed package's registry signature doesn't verify, and it
reports provenance attestations where packages have them. It needs the registry, so
run it after install and before build.

### 4.6 Lockfile integrity

The lockfile currently resolves every package from `https://registry.npmjs.org`
(workspaces aside). Keep it that way with a check that fails on any `resolved` URL
that isn't the registry or a workspace path, and on any entry missing `integrity`.
Either `lockfile-lint` or a short script in `scripts/` works; the script avoids adding
a dependency:

```bash
node -e '
const l = require("./package-lock.json"); let bad = 0;
for (const [k, v] of Object.entries(l.packages)) {
  // Skip the root, workspace folders and workspace symlinks.
  if (!k.includes("node_modules/") || v.link) continue;
  if (!v.resolved?.startsWith("https://registry.npmjs.org/")) { console.error("non-registry:", k, v.resolved); bad++; }
  if (!v.integrity) { console.error("no integrity:", k); bad++; }
}
process.exit(bad ? 1 : 0);'
```

Treat that as a starting point; wire the final version into `validate-static-build`.

---

## 5. Phase 3: detection ([settings] + [repo])

### 5.1 Workflow and code scanning

- **[settings] CodeQL default setup:** add the **`actions`** language and switch the
  suite to **`security-extended`** (see [`CI_CD.md` §2](./CI_CD.md#2-code-scanning-codeql)).
  The `actions` analysis finds script injection and unsafe triggers.
- **[repo] zizmor:** add a workflow that runs `zizmor` on `.github/` for PRs that
  touch `.github/**`, uploading SARIF to code scanning. It catches template
  injection, excessive permissions, credential persistence, cache poisoning and
  unpinned actions. Start report-only; make it required once clean.
- **[repo] Scorecard:** already running. Treat a drop in any check as a regression and
  fix it in the weekly maintenance sweep.

### 5.2 Dependency intelligence

- Dependency Review already blocks high-severity advisories and unapproved licenses.
  Consider adding `deny-packages` for known-bad names and
  `warn-on-openssf-scorecard-level` so PRs that add low-reputation packages are
  flagged.
- Optional: a behavioural scanner such as Socket (free for open source). It flags new
  install scripts, network or shell access, obfuscated code and typosquats in new
  dependencies, which `npm audit` (known CVEs only) doesn't see.

### 5.3 Alerts that reach you

- Watch the repo for *Security alerts*; check that email notifications for Dependabot
  and code scanning alerts are on.
- npmjs.com sends an email on every publish of `restura-cli`. An email for a version
  you didn't release means §9.2.

---

## 6. Phase 4: dependency intake policy ([repo], applies to every PR)

Add this checklist to `CONTRIBUTING.md` and the code-review skill. A new **direct**
dependency needs:

1. A reason the standard library, an existing dependency or ~50 lines of our own code
   won't do.
2. Look at the package before adding it: weekly downloads, number of maintainers,
   age, recent ownership changes, whether it has an install script, whether it
   publishes with provenance (`npm view <pkg> --json | jq .dist.attestations`).
3. Lockfile diff reviewed: how many transitive packages it pulls in. More than ~20 new
   packages for a small feature needs justification.
4. Exact name check against typosquats (compare with the GitHub repo the docs link to).
5. Added to the install-script allowlist (§4.2) if it has a script, with a reason.

Existing rules that stay:

- Dependabot auto-merge only covers patch/minor updates, waits for the cooldown, and
  needs green required checks. Don't widen it to majors.
- Prefer `overrides` scoped to the vulnerable path (see the `dependabot-remediate`
  skill) over blanket upgrades.
- Vendored code under `vendor/` is third-party code too: record the upstream commit
  and licence in each subfolder and review updates like dependency bumps.
- CI-only tools are pinned by lockfile under `.github/tools/<tool>/` (exists); keep
  every new CI tool that way rather than `npx some-tool@latest`.

---

## 7. Phase 5: AI agents and developer tooling

Restura uses Claude Code in CI (`claude.yml`, `claude-code-review.yml`,
`dependabot-remediate.yml`, `eval-harness.yml`) and ships agent skills and hooks.
Treat them as part of the supply chain.

- **Trigger gating (exists):** `claude.yml` only reacts to OWNER, MEMBER or
  COLLABORATOR. Keep that on every new agent workflow, and never trigger an agent with
  write access from `issues` or `pull_request_target` events by outsiders.
- **Tool allowlists:** keep `--allowedTools` as narrow as `dependabot-remediate.yml`
  (named files, `--ignore-scripts` installs only). An agent that reads untrusted text
  (issue bodies, PR diffs, web pages) should never hold a token that can push to
  `main`, publish, or read release secrets.
- **Treat agent output like a contributor's PR:** agent-opened PRs go through the same
  required checks and human review; no ruleset bypass for agent identities.
- **Third-party skills:** `skills-lock.json` records a content hash per imported skill.
  Review the diff before updating a hash, and add a CI check that the checked-in
  skill files still match their recorded hashes.
- **Hooks and MCP servers:** `.claude/hooks/` run on every contributor's machine that
  uses Claude Code in this repo. Review changes to `.claude/settings.json`,
  `.claude/hooks/**` and any MCP server config with the same care as CI workflows,
  and add them to the second-reviewer `CODEOWNERS` paths (§2.4).
- **Contributor machines:** `npm install` runs install scripts on the developer's
  laptop. The optional `ignore-scripts` setup in §4.2 step 4 covers that.

---

## 8. Phase 6: help users verify what they install ([repo])

Provenance only protects people who check it. [`CI_CD.md`](./CI_CD.md#verifying-attestations)
has the commands; surface them where users look:

- Add a *Verifying downloads* section to `SECURITY.md` and the README install section:
  ```bash
  gh attestation verify Restura-<version>.dmg --repo dipjyotimetia/restura
  gh attestation verify oci://ghcr.io/dipjyotimetia/restura:<version> --repo dipjyotimetia/restura
  npm audit signatures   # inside a project that depends on restura-cli
  ```
- Put the expected signing identities in the release notes template
  (`docs/RELEASE_NOTES_TEMPLATE.md`): macOS Developer ID team ID, Windows publisher
  name.
- Recommend pinning the Docker image by digest (`ghcr.io/dipjyotimetia/restura@sha256:…`)
  in `SELF_HOSTING.md`.
- The SBOM attached to each release is the answer to "am I affected by CVE-X";
  mention it in `SECURITY.md`.

---

## 9. Incident response

Write down who does what before it happens. Keep this section short enough to follow
under stress.

### 9.1 A dependency we use is reported compromised

1. Check whether we ever installed the bad version:
   `git log -p -S '"<pkg>": {' -- package-lock.json` and `npm ls <pkg>`.
2. If it was never in the lockfile: pin or override it away from the bad range and
   stop.
3. If it was installed in CI: treat every secret that any affected job could reach as
   leaked. Rotate in this order: npm (if not yet on trusted publishing), Cloudflare,
   restura-bot App key, signing certificates (revoke with Apple/CA if a key file was
   reachable), marketplace tokens, Sentry.
4. If it reached a shipped artifact: go to §9.3.
5. Check Actions logs for the affected runs (`harden-runner` reports, if enabled,
   show outbound connections).

### 9.2 A credential leaked or an unexpected publish happened

1. Revoke the credential at its source first (npm, Cloudflare, GitHub App, PAT).
   Revoking before investigating is correct; a new one can be issued in minutes.
2. npm: `npm deprecate restura-cli@<bad> "compromised, do not use"`; ask npm support to
   remove the version (unpublish within 72 hours is self-service if nothing depends on
   it).
3. Review the account's audit log (GitHub: Settings → Security log; npm: account
   activity; Cloudflare: audit logs).
4. Re-check §2.1 2FA on the account that leaked.

### 9.3 A shipped release is bad

1. Mark the GitHub release as a pre-release and edit its notes with a warning;
   delete its assets.
2. Deprecate the npm version; delete the GHCR tag (keep the digest for forensics);
   roll the Cloudflare deployment back to the previous version (Pages deployments →
   *Rollback*); unpublish or roll back the extensions.
3. Publish a GitHub Security Advisory with affected versions and the verification
   steps from §8 so users can tell clean installs from bad ones.
4. Cut a clean patch release from a known-good commit, after rotating credentials.
5. Post-incident: record what happened in `docs/audits/` and add the missing control
   to this doc.

---

## 10. Ongoing cadence

| When | What |
|---|---|
| Every PR | Dependency intake checklist (§6) for new direct deps; lockfile diff skimmed; workflow changes reviewed with zizmor output |
| Weekly (existing `triage-maintenance` sweep) | Security audit run, Scorecard changes, Dependabot alerts, `harden-runner` reports, open code-scanning alerts |
| Monthly | Allowed-actions list and install-script allowlist still match reality; unused credentials removed |
| Quarterly | Rotate long-lived tokens that remain (Cloudflare, marketplaces, Sentry); review GitHub Apps, OAuth apps, collaborators, deploy keys; check 2FA on every account in §2.3 |
| Yearly | Signing certificate expiry dates; re-read this doc and the threat model |

---

## 11. Tracking

Open one GitHub issue per row and tick it off here when it lands.

| Task | Section | Type | Priority | Status |
|---|---|---|---|---|
| Phishing-resistant 2FA on GitHub, npm, Cloudflare, Apple, marketplaces | §2.1 | settings | P0 | ☐ |
| Credential inventory + scope reduction | §2.3 | settings | P0 | ☐ |
| npm trusted publishing + split pack/publish; delete `NPM_TOKEN` | §3.1 | repo + settings | P0 | ☐ |
| `release` / `extensions` environments, secrets moved | §3.2 | repo + settings | P0 | ☐ |
| `v*` tag ruleset, fork-PR approval, allowed-actions list, default token read-only | §2.4 | settings | P1 | ☐ |
| Attestation moved to jobs without `npm ci` | §4.1 | repo | P1 | ☐ |
| `persist-credentials: false` on non-pushing checkouts | §4.4 | repo | P1 | ☐ |
| Install-script allowlist + check | §4.2 | repo | P1 | ☐ |
| CodeQL `actions` + `security-extended` | §5.1 | settings | P1 | ☐ |
| zizmor workflow | §5.1 | repo | P1 | ☐ |
| `npm audit signatures` in CI and release | §4.5 | repo | P2 | ☐ |
| Lockfile integrity check | §4.6 | repo | P2 | ☐ |
| `harden-runner` audit, then block on release jobs | §4.3 | repo | P2 | ☐ |
| Dependency intake checklist in `CONTRIBUTING.md` | §6 | repo | P2 | ☐ |
| `skills-lock.json` hash check; agent/hook paths in `CODEOWNERS` | §7 | repo | P2 | ☐ |
| Verification docs in `SECURITY.md` / README / release template | §8 | repo | P2 | ☐ |
| Remote signing for desktop builds | §4.1 | repo + settings | P3 | ☐ |
| Second maintainer in `CODEOWNERS` for sensitive paths | §2.4 | settings | P3 | ☐ |
