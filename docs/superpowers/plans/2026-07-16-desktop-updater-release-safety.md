# Desktop Updater Release Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unsigned stable macOS updater artifacts, expose post-download updater failures, and publish a verified v1.6.1 emergency release.

**Architecture:** Keep the existing candidate-SHA release flow, but use one identical trusted-PR predicate for both publishing and signing overrides. Make stable macOS signing fail closed. Treat Electron's native Squirrel event as the macOS install-readiness boundary. Persist actionable updater failures in the renderer. Gate public release promotion on verification of the packaged artifact rather than only the build directory.

**Tech Stack:** GitHub Actions, Electron 43, electron-updater 6, TypeScript, React 19, Vitest 4, Electron Builder 26, Apple `codesign`/`spctl`/`stapler`, Biome.

## Global constraints

- [ ] Preserve the current merged release-bot pull-request and candidate-SHA release flow.
- [ ] Only a trusted, merged release PR may enable both `PUBLISH_FOR_PULL_REQUEST` and `CSC_FOR_PULL_REQUEST`; the predicates must be textually identical.
- [ ] Stable macOS builds must use Developer ID Application signing for the configured Apple team. Ad-hoc signing remains acceptable only for builds where stable signing is not required.
- [ ] Preserve the existing bundle identifier, hardened-runtime configuration, IPC validation, updater channels, and release manifest format.
- [ ] Do not replace or mutate v1.6.0 assets. Publish the repair as immutable v1.6.1 artifacts.
- [ ] Keep automatic/background check failures quiet, but show download, validation, and installation failures persistently with recovery actions.
- [ ] Do not expose secrets, raw local paths, or unfiltered native error strings to the renderer.
- [ ] Use Biome and run `npm run electron:compile` plus the full `npm run validate` gate before publication.
- [ ] Do not claim real Windows or Linux relaunch coverage unless those platform journeys are actually run. Verify their packaged assets and manifests structurally.

---

## Task 1: Authorize signing only for trusted merged release PRs

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `tests/release-sentry-workflow.test.ts`

### 1.1 Write the failing workflow-policy test

- [ ] Extend the release workflow test to extract the `${{ ... }}` expressions assigned to `PUBLISH_FOR_PULL_REQUEST` and `CSC_FOR_PULL_REQUEST`.
- [ ] Assert both variables exist, their expressions are exactly equal, and the shared expression contains all existing trust conditions: pull-request event, merged state, expected release branch/head, expected actor, and repository-owner constraints.
- [ ] Assert the desktop job defines `RESTURA_REQUIRE_SIGNED_MAC` and limits it to stable macOS releases.

Use a helper shaped like:

```ts
function workflowExpressionFor(source: string, key: string): string {
  const match = source.match(new RegExp(`${key}:\\s*\\$\\{\\{([\\s\\S]*?)\\}\\}`));
  expect(match, `${key} must be defined`).not.toBeNull();
  return match?.[1]?.replace(/\\s+/g, " ").trim() ?? "";
}
```

The exact regex may be adjusted to the workflow's YAML formatting, but it must compare the full normalized predicates rather than selected fragments.

### 1.2 Prove the test fails

- [ ] Run:

```bash
npm run test:run -- tests/release-sentry-workflow.test.ts
```

Expected: failure because `CSC_FOR_PULL_REQUEST` and the stable-signing requirement are absent.

### 1.3 Add the minimum workflow policy

- [ ] In the desktop build job, add `CSC_FOR_PULL_REQUEST` with the exact expression already used by `PUBLISH_FOR_PULL_REQUEST`.
- [ ] Add:

```yaml
RESTURA_REQUIRE_SIGNED_MAC: ${{ runner.os == 'macOS' && needs.release.outputs.is_prerelease == 'false' }}
```

- [ ] Do not broaden PR signing or publication to arbitrary forks, unmerged PRs, user-authored branches, or untrusted actors.

### 1.4 Prove the policy test passes

- [ ] Run:

```bash
npm run test:run -- tests/release-sentry-workflow.test.ts
```

Expected: the workflow-policy suite passes.

### 1.5 Commit

```bash
git add .github/workflows/release.yml tests/release-sentry-workflow.test.ts
git commit -m "fix(release): authorize signing for trusted release PRs"
```

---

## Task 2: Make stable macOS signing verification fail closed

**Files:**

- Modify: `scripts/verify-electron-signature.mjs`
- Modify: `tests/release/verify-electron-signature.test.ts`

### 2.1 Define the verification policy in tests

- [ ] Change the test fixture for a valid signed app to include all required metadata:

```text
Identifier=com.dipjyotimetia.restura
CodeDirectory v=20500 size=... flags=0x10000(runtime) ...
Authority=Developer ID Application: Dipjyoti Metia (S7NSMM7XB2)
TeamIdentifier=S7NSMM7XB2
```

- [ ] Exercise a policy object with this shape:

```ts
{
  requireDeveloperId: true,
  expectedTeamIdentifier: "S7NSMM7XB2",
  expectedBundleIdentifier: "com.dipjyotimetia.restura",
}
```

- [ ] Add failing cases for:
  - `Signature=adhoc` when Developer ID is required.
  - Missing or incorrect `TeamIdentifier`.
  - Missing or incorrect bundle identifier.
  - Missing hardened-runtime flag.
  - A non-Developer-ID authority.
- [ ] Preserve a development case where ad-hoc signing returns `skipped` when `requireDeveloperId` is false.

### 2.2 Prove the tests fail

- [ ] Run:

```bash
npm run test:run -- tests/release/verify-electron-signature.test.ts
```

Expected: new fail-closed policy cases fail against the current permissive verifier.

### 2.3 Implement explicit policy verification

- [ ] Evolve the API to:

```js
export async function verifySignedMacApp(appPath, policy = {}, execute = run)
```

- [ ] Add a small metadata parser, for example `metadataValue(output, key)`, and verify:
  - exact `TeamIdentifier` match;
  - exact bundle identifier match;
  - authority begins with `Developer ID Application:` and includes the expected team in parentheses;
  - `CodeDirectory` reports the `runtime` flag;
  - strict deep signature verification succeeds with `codesign --verify --deep --strict --verbose=4`.
- [ ] If `requireDeveloperId` is true, treat missing policy values, ad-hoc signing, malformed metadata, or any command failure as fatal.
- [ ] Keep the result object free of secret material and avoid printing signing credentials.
- [ ] In `afterSign(context)`, derive `requireDeveloperId` only from `RESTURA_REQUIRE_SIGNED_MAC === "true"`. When required, fail if `APPLE_TEAM_ID` is missing, and pass the configured bundle identifier from the build context/config.

### 2.4 Prove the verifier passes

- [ ] Run:

```bash
npm run test:run -- tests/release/verify-electron-signature.test.ts
```

Expected: valid Developer ID metadata passes, every required-policy mismatch fails, and optional ad-hoc builds remain skipped.

### 2.5 Commit

```bash
git add scripts/verify-electron-signature.mjs tests/release/verify-electron-signature.test.ts
git commit -m "fix(release): require Developer ID for stable mac builds"
```

---

## Task 3: Wait for native macOS validation before enabling restart

**Files:**

- Modify: `electron/types/electron-api.ts`
- Modify: `electron/main/lifecycle/auto-updater.ts`
- Modify: `electron/main/lifecycle/__tests__/auto-updater.test.ts`

### 3.1 Add failing state-machine tests

- [ ] Extend the Electron mocks to expose separate listener registries for electron-updater and Electron's native `autoUpdater`, plus the registered IPC handlers.
- [ ] Use `vi.spyOn(process, "platform", "get").mockReturnValue("darwin")` for macOS-specific cases and restore it after each test.
- [ ] Add these assertions:
  1. electron-updater's early `update-downloaded` event emits `{ state: "validating" }` on macOS, not `downloaded`.
  2. Electron native `autoUpdater`'s `update-downloaded` event is the event that emits `{ state: "downloaded" }`.
  3. An error after entering validation emits `{ state: "error", phase: "validation" }` with a safe generic message.
  4. Calling the restart IPC handler before native readiness rejects and does not call `quitAndInstall`.
  5. Calling restart after native readiness emits `installing` and invokes `quitAndInstall(false, true)`.
  6. Non-macOS platforms still become ready from electron-updater's public `update-downloaded` event.

### 3.2 Prove the state-machine tests fail

- [ ] Run:

```bash
npm run test:run -- electron/main/lifecycle/__tests__/auto-updater.test.ts
```

Expected: the current implementation announces `downloaded` too early and has no restart readiness guard.

### 3.3 Expand the typed updater states

- [ ] In `electron/types/electron-api.ts`, add `validating` and `installing` to the updater-state union.
- [ ] Add:

```ts
export type UpdaterErrorPhase = "check" | "download" | "validation" | "install";
```

- [ ] Add optional `phase?: UpdaterErrorPhase` to `UpdaterStatus`.

### 3.4 Implement the native readiness boundary

- [ ] Import Electron's native updater distinctly:

```ts
import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, ipcMain } from "electron";
```

- [ ] Add a module-scoped readiness flag that resets on a newly available update and becomes true only when the platform-specific ready event fires.
- [ ] On macOS:
  - electron-updater `update-downloaded` broadcasts `validating`;
  - native `update-downloaded` marks the update ready and broadcasts `downloaded`.
- [ ] On non-macOS platforms, electron-updater `update-downloaded` marks the update ready directly.
- [ ] Track the active phase so error events can be classified. Log the original error in the main-process log, but broadcast only phase-specific safe copy.
- [ ] The restart IPC handler must reject if readiness is false. Once ready, it broadcasts `installing` immediately before `quitAndInstall(false, true)`.
- [ ] Avoid duplicate listener registration if updater initialization can be invoked more than once in tests or lifecycle recovery.

### 3.5 Prove the state machine and Electron build pass

- [ ] Run:

```bash
npm run test:run -- electron/main/lifecycle/__tests__/auto-updater.test.ts
npm run electron:compile
```

Expected: all updater tests pass and Electron main/preload/types compile cleanly.

### 3.6 Commit

```bash
git add electron/types/electron-api.ts electron/main/lifecycle/auto-updater.ts electron/main/lifecycle/__tests__/auto-updater.test.ts
git commit -m "fix(desktop): wait for native update validation"
```

---

## Task 4: Show persistent updater failures with recovery actions

**Files:**

- Modify: `src/components/shared/UpdateNotification.tsx`
- Modify: `src/components/shared/__tests__/UpdateNotification.test.tsx`

### 4.1 Add failing UI behavior tests

- [ ] Extend the Electron bridge mock with `shell.openExternal`.
- [ ] Add tests proving:
  - a validation-phase error renders a persistent alert and never shows `Restart now`;
  - selecting `Retry` invokes `api.updater.check()`;
  - selecting `Manual download` opens `https://github.com/dipjyotimetia/restura/releases/latest` through `api.shell.openExternal`;
  - check-phase/background errors remain hidden;
  - `validating` renders `Verifying update…` and `installing` renders `Restarting to install…`;
  - `downloaded` still offers `Restart now`.

### 4.2 Prove the UI tests fail

- [ ] Run:

```bash
npm run test:run -- src/components/shared/__tests__/UpdateNotification.test.tsx
```

Expected: validation errors are currently hidden and the recovery actions do not exist.

### 4.3 Implement the persistent error panel

- [ ] Remove the previous-state rule that only surfaces errors immediately following `downloading`.
- [ ] Keep automatic `check` errors quiet, but include non-check `error`, `validating`, and `installing` in the component's visible states.
- [ ] Render a compact `AlertTriangle` treatment for active-operation errors with safe phase-aware titles.
- [ ] Provide `Retry` and `Manual download` actions. Route the manual URL through the existing Electron shell bridge; do not use raw `window.open`.
- [ ] Keep the existing update-available, progress, downloaded, dismissal, and tray-toast behavior intact.
- [ ] Disable or hide actions while the corresponding operation is already in progress.

### 4.4 Prove the UI passes

- [ ] Run:

```bash
npm run test:run -- src/components/shared/__tests__/UpdateNotification.test.tsx
```

Expected: all existing and new updater notification tests pass.

### 4.5 Commit

```bash
git add src/components/shared/UpdateNotification.tsx src/components/shared/__tests__/UpdateNotification.test.tsx
git commit -m "fix(desktop): surface updater validation failures"
```

---

## Task 5: Gate public promotion on packaged macOS artifacts

**Files:**

- Modify: `scripts/verify-electron-signature.mjs`
- Modify: `tests/release/verify-electron-signature.test.ts`
- Modify: `.github/workflows/release.yml`
- Modify: `tests/release-sentry-workflow.test.ts`
- Modify: `docs/CI_CD.md`
- Modify: `docs/DISTRIBUTION.md`

### 5.1 Add failing CLI and workflow-placement tests

- [ ] Export and test a `parseCliPolicy(args)` helper supporting:

```text
<app-path> --require-developer-id --team-id <team> [--bundle-id <identifier>]
```

- [ ] Test missing app path, missing team for a required Developer ID policy, and unknown flags.
- [ ] Extend the workflow test to assert a stable-mac packaged-artifact verification step:
  - occurs after the desktop build/package command;
  - occurs before provenance/attestation and public release promotion;
  - invokes the verifier against an app extracted from the release ZIP;
  - passes the expected team;
  - validates the notarization ticket on the app extracted from the shipped ZIP;
  - uses `set -euo pipefail` and checks files are non-empty.

### 5.2 Prove the tests fail

- [ ] Run:

```bash
npm run test:run -- tests/release/verify-electron-signature.test.ts tests/release-sentry-workflow.test.ts
```

Expected: no verifier CLI or packaged-artifact gate exists yet.

### 5.3 Add a safe verifier CLI

- [ ] Use `fileURLToPath(import.meta.url)` to run the CLI only when the module is the process entry point.
- [ ] Print only a concise verified/skipped result; send failures to stderr and set a non-zero exit code.
- [ ] Reuse `verifySignedMacApp` rather than duplicating signature logic.

### 5.4 Add the packaged-artifact release gate

- [ ] Add this stable-mac step immediately after packaging and before attestation/public promotion, adapting only filenames if the existing builder output differs:

```yaml
- name: Verify signed macOS release artifacts
  if: ${{ runner.os == 'macOS' && needs.release.outputs.is_prerelease == 'false' }}
  env:
    ACTUAL_TAG: ${{ needs.release.outputs.actual_tag }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  shell: bash
  run: |
    set -euo pipefail
    VERSION="${ACTUAL_TAG#v}"
    ZIP="dist/installers/Restura-${VERSION}-arm64-mac.zip"
    DMG="dist/installers/Restura-${VERSION}-arm64.dmg"
    test -s "$ZIP"
    test -s "$DMG"
    WORK_DIR="$(mktemp -d)"
    trap 'rm -rf "$WORK_DIR"' EXIT
    ditto -x -k "$ZIP" "$WORK_DIR"
    node scripts/verify-electron-signature.mjs \
      "$WORK_DIR/Restura.app" \
      --require-developer-id \
      --team-id "$APPLE_TEAM_ID" \
      --bundle-id "com.dipjyotimetia.restura"
    xcrun stapler validate "$WORK_DIR/Restura.app"
```

- [ ] Confirm the step runs against the exact ZIP/DMG names referenced by `latest-mac.yml` and the GitHub release.
- [ ] It is acceptable for electron-builder to upload assets to a draft release before this verification; a failed desktop matrix must prevent that draft from becoming public.

### 5.5 Document incident prevention and recovery

- [ ] In `docs/CI_CD.md`, document the shared trusted-PR signing/publishing predicate, stable signing requirement, packaged artifact gate, and public-promotion dependency.
- [ ] In `docs/DISTRIBUTION.md`, document the user-visible updater sequence and the immutable recovery rule: publish a new patch release; never replace updater assets for an existing public version.
- [ ] Include an operator check for Developer ID team, bundle identifier, hardened runtime, ZIP hash/size, and the extracted app's notarization ticket.

### 5.6 Prove focused tests pass

- [ ] Run:

```bash
npm run test:run -- tests/release/verify-electron-signature.test.ts tests/release-sentry-workflow.test.ts
npm run format:check
```

Expected: verifier CLI tests and workflow placement/policy tests pass; edited files are Biome-clean.

### 5.7 Commit

```bash
git add scripts/verify-electron-signature.mjs tests/release/verify-electron-signature.test.ts .github/workflows/release.yml tests/release-sentry-workflow.test.ts docs/CI_CD.md docs/DISTRIBUTION.md
git commit -m "fix(release): gate publication on signed mac artifacts"
```

---

## Task 6: Run full verification and land the repair

### 6.1 Run focused regression suites together

- [ ] Run:

```bash
npm run test:run -- electron/main/lifecycle/__tests__/auto-updater.test.ts src/components/shared/__tests__/UpdateNotification.test.tsx tests/release/verify-electron-signature.test.ts tests/release-sentry-workflow.test.ts
npm run electron:compile
```

Expected: updater state, renderer recovery, signing policy, workflow policy, and Electron compilation all pass in one fresh run.

### 6.2 Run repository gates

- [ ] Run:

```bash
npm run validate
git diff --check origin/main...HEAD
git status --short
```

Expected: full validation succeeds, no whitespace errors exist, and only intentional changes are present.

### 6.3 Perform a fresh-context review

- [ ] Review `git diff origin/main...HEAD` specifically for:
  - trust-predicate drift between publishing and signing;
  - stable paths that could still accept ad-hoc signatures;
  - a renderer-visible restart path before native readiness;
  - unsafe native error leakage;
  - listener duplication or state races;
  - workflow steps that verify a build directory instead of shipped artifacts;
  - docs that contradict the actual release graph.
- [ ] Fix any finding with a failing regression test first, then rerun the focused and full gates.

### 6.4 Push and open the focused PR

- [ ] Push the branch:

```bash
git push -u origin fix/desktop-updater-release-safety
```

- [ ] Open a draft PR titled `fix(release): restore signed desktop updates`, explaining the v1.6.0 signing regression, the state-machine/UI repair, the fail-closed packaged-artifact gate, and exact verification results.
- [ ] Monitor required checks. Mark ready and merge only after the trusted workflow-policy tests, Electron tests, and complete validation are green.
- [ ] Recheck that `main` contains the merge before triggering the repair release.

---

## Task 7: Publish and verify immutable v1.6.1

### 7.1 Trigger the patch release from merged `main`

- [ ] Run:

```bash
gh workflow run release.yml --repo dipjyotimetia/restura --ref main -f release_bump=patch
```

- [ ] Monitor both release preparation and trusted merged-PR publication jobs. Confirm the logs show signing was enabled, not skipped, and the packaged-artifact gate passed before public promotion.

### 7.2 Audit public release metadata and assets

- [ ] Download the public updater manifests, macOS ZIP/DMG, Windows installer, and Linux AppImage/deb into `/tmp/restura-v1.6.1-audit`.
- [ ] Confirm manifest URLs, filenames, sizes, versions, and SHA-512 values match the public assets byte-for-byte.
- [ ] Extract the exact public macOS ZIP and run:

```bash
node scripts/verify-electron-signature.mjs \
  /tmp/restura-v1.6.1-audit/extracted/Restura.app \
  --require-developer-id \
  --team-id S7NSMM7XB2 \
  --bundle-id com.dipjyotimetia.restura
xcrun stapler validate /tmp/restura-v1.6.1-audit/extracted/Restura.app
```

- [ ] Verify the public release is non-draft, non-prerelease, tagged from the intended merged candidate SHA, and has no duplicate or stale v1.6.1 assets.

### 7.3 Run the real macOS N-1 update journey

- [ ] Start from the existing Developer-ID-signed v1.5.0 installation in `/Applications/Restura.app`; record its version and signature before the update.
- [ ] Launch it and verify the visible sequence: update available → downloading → verifying → ready.
- [ ] Select `Restart now` and confirm the app exits, installs v1.6.1, relaunches, and reports v1.6.1.
- [ ] Re-run signature and TeamIdentifier checks against the installed app and inspect the updater log for the absence of `SQRLCodeSignatureErrorDomain`.
- [ ] Exercise `Check for updates` once more and confirm v1.6.1 reports no newer stable update without an error panel.

### 7.4 Record platform-accurate evidence

- [ ] Record exact workflow run/job URLs, release URL, candidate SHA, public asset hashes, macOS signature metadata, stapling result, updater log result, and installed version after relaunch.
- [ ] For Windows/Linux, report only manifest/package verification unless real machines execute their install/relaunch paths.
- [ ] If publication partially succeeds and recovery would require deleting a release, deleting a tag, or replacing assets, stop and request an explicit destructive recovery decision. Do not mutate public v1.6.1 silently.

---

## Required completion evidence

- [ ] The trusted signing and publishing predicates are identical and regression-tested.
- [ ] Stable macOS ad-hoc output fails both the post-sign hook and packaged-artifact gate.
- [ ] Renderer `Restart now` cannot appear until native macOS validation succeeds.
- [ ] Validation/install failures remain visible and offer retry/manual recovery.
- [ ] `npm run electron:compile` and `npm run validate` pass from the final tree.
- [ ] The merged repair commit is the source of the v1.6.1 release.
- [ ] Public v1.6.1 manifests match public assets.
- [ ] Public macOS ZIP is Developer ID signed for team `S7NSMM7XB2`, has bundle ID `com.dipjyotimetia.restura`, hardened runtime, a valid signature, and a valid notarization ticket on the extracted app.
- [ ] A real v1.5.0 macOS installation updates, installs, and relaunches as v1.6.1.
