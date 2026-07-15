# Release PR Publish Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish desktop artifacts from the trusted merged release-candidate PR and provide a desktop-only repair for an existing draft release.

**Architecture:** The release workflow retains its existing preflight authorization. The desktop matrix receives Electron Builder's PR-publish override only for the trusted merged-bot event. A repair dispatch carries an existing tag through a desktop-only path, verifies updater metadata, and promotes the draft without touching npm, Docker, web deployment, or tag creation.

**Tech Stack:** GitHub Actions expressions and Bash, Electron Builder, Vitest, js-yaml.

## Global Constraints

- `PUBLISH_FOR_PULL_REQUEST=true` is permitted only for a merged `restura-bot[bot]` `release/prepare` PR targeting `main`.
- Repair uses an existing tag and must not recreate/rewrite a tag, republish npm, publish Docker, or deploy Cloudflare.
- Stable and prerelease manual release behavior remains unchanged.

---

### Task 1: Lock release authorization with regression tests

**Files:**
- Modify: `tests/release-sentry-workflow.test.ts`

**Interfaces:**
- Consumes: `.github/workflows/release.yml` as UTF-8 text.
- Produces: guardrail assertions for trusted PR publishing and repair isolation.

- [ ] **Step 1: Write the failing test**

Append a test that slices the `Build + publish installers` block and asserts it contains `PUBLISH_FOR_PULL_REQUEST:`, `github.event_name == 'pull_request'`, `github.event.pull_request.merged`, `github.event.pull_request.base.ref == 'main'`, `github.event.pull_request.head.ref == 'release/prepare'`, and `github.event.pull_request.user.login == 'restura-bot[bot]'`.

- [ ] **Step 2: Verify RED**

Run `npm run test:run -- tests/release-sentry-workflow.test.ts`. Expected: FAIL because the desktop publishing environment has no PR-publish guard.

### Task 2: Add trusted PR publishing and tag-bound repair mode

**Files:**
- Modify: `.github/workflows/release.yml:17-72`
- Modify: `.github/workflows/release.yml:325-640`
- Modify: `.github/workflows/release.yml:658-939`
- Modify: `tests/release-sentry-workflow.test.ts`

**Interfaces:**
- Consumes: `workflow_dispatch.inputs.repair_release_tag` as an existing `vX.Y.Z` tag.
- Produces: `needs.release.outputs.is_repair` (`'true' | 'false'`) for downstream job conditions.

- [ ] **Step 1: Add repair input and validation**

Add `repair_release_tag` below `recover_stable_release_sha`, reject it when a prerelease/recovery SHA is supplied, and require `^v[0-9]+\.[0-9]+\.[0-9]+$`.

- [ ] **Step 2: Add repair context**

Expose `is_repair` from `Resolve release context`, use the supplied tag as `actual_tag`, verify the existing GitHub release is still draft, and skip tag validation/push, changelog/SBOM generation, and release creation for repairs.

- [ ] **Step 3: Add the minimal publishing override**

Add this desktop-job environment entry after `GH_TOKEN`:

`PUBLISH_FOR_PULL_REQUEST: ${{ github.event_name == 'pull_request' && github.event.pull_request.merged && github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.ref == 'release/prepare' && github.event.pull_request.user.login == 'restura-bot[bot]' }}`

- [ ] **Step 4: Isolate repair work**

Require `needs.release.outputs.is_repair != 'true'` on `publish-cli`, `publish-docker`, and `deploy-web`; retain the existing updater verification and draft promotion job for repair.

- [ ] **Step 5: Verify GREEN**

Run `npm run test:run -- tests/release-sentry-workflow.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

Run `git add .github/workflows/release.yml tests/release-sentry-workflow.test.ts && git commit -m "fix(release): publish trusted release PR installers"`.

### Task 3: Validate workflow syntax and release invariants

**Files:**
- Verify: `.github/workflows/release.yml`
- Verify: `tests/release-sentry-workflow.test.ts`

**Interfaces:**
- Consumes: the updated workflow and regression test.
- Produces: syntax and behavior evidence.

- [ ] **Step 1: Parse the workflow**

Run `node -e "const fs=require('node:fs'); const yaml=require('js-yaml'); yaml.load(fs.readFileSync('.github/workflows/release.yml','utf8')); console.log('release workflow YAML valid')"`. Expected: `release workflow YAML valid`.

- [ ] **Step 2: Check formatting and whitespace**

Run `npx prettier --check .github/workflows/release.yml tests/release-sentry-workflow.test.ts && git diff --check`. Expected: exit 0.

- [ ] **Step 3: Re-run guardrails**

Run `npm run test:run -- tests/release-sentry-workflow.test.ts`. Expected: PASS.
