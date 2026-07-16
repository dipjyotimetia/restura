# Desktop Updater Release Safety Design

## Goal

Restore reliable signed desktop updates after the v1.6.0 macOS updater artifact was published with an ad-hoc signature, make equivalent failures visible to users, and publish a verified immutable v1.6.1 emergency release.

## Incident summary

The v1.6.0 release ran from the trusted merged `restura-bot[bot]` `release/prepare` pull-request event. The desktop job set `PUBLISH_FOR_PULL_REQUEST=true`, allowing Electron Builder to upload installers, but did not set the separate `CSC_FOR_PULL_REQUEST=true` override required for macOS signing in pull-request contexts.

Electron Builder therefore skipped Developer ID signing even though Apple credentials were present. The existing `afterSign` verifier treated an ad-hoc signature as an acceptable development build, so the stable workflow remained green and published the artifact. Squirrel.Mac downloaded the ZIP, then rejected the extracted app with `SQRLCodeSignatureErrorDomain` because it no longer satisfied the installed v1.5.0 app's Developer ID requirement.

The renderer briefly received `update-downloaded` before Squirrel completed native validation. Its error policy only surfaced errors that immediately followed `downloading`, so the subsequent validation error was hidden after the intermediate `downloaded` state.

## Scope

This repair covers one coherent updater-release topic:

- Trusted macOS signing in the merged stable-release PR path.
- Fail-closed stable macOS signature, identity, and notarization verification.
- Clear updater state and user feedback for post-download validation/install failures.
- Regression tests for workflow authorization, signature policy, updater lifecycle, and UI behavior.
- Release runbook updates.
- Publication and independent verification of a new immutable v1.6.1 release.
- A real macOS v1.5.0 to v1.6.1 update, install, restart, and version verification.

The repair does not replace v1.6.0 assets, rewrite the full release architecture, add new update providers, or change unrelated desktop lifecycle behavior.

## Chosen approach

Keep the current candidate-SHA-pinned merged-release workflow and repair its signing boundary. This is safer during an active incident than replacing the release system. A later change may move publication into a non-PR reusable workflow and remove both PR overrides.

Replacing v1.6.0 assets is rejected because it would undermine release immutability, published digests, attestations, caches, and auditability. The recovery release will be v1.6.1.

## Release authorization and signing

The desktop job will apply one identical trusted predicate to both PR-specific Electron Builder overrides:

- Event is `pull_request`.
- Pull request is merged.
- Base branch is `main`.
- Head branch is `release/prepare`.
- Author is `restura-bot[bot]`.

Only that path may set both `PUBLISH_FOR_PULL_REQUEST=true` and `CSC_FOR_PULL_REQUEST=true`. Ordinary pull requests must never receive either override or signing credentials.

Stable macOS builds will receive an explicit policy flag stating that Developer ID signing is required and the expected `APPLE_TEAM_ID`. Prerelease and local builds retain the existing policy unless their workflow explicitly requires signing. The stable job must fail before upload or publication when the required identity cannot be proven.

## Signature verification policy

`scripts/verify-electron-signature.mjs` will separate development and release policies:

- Development policy may return a structured `skipped` result for an ad-hoc signature.
- Required-release policy rejects ad-hoc signatures.
- Required-release policy verifies the bundle with `codesign --verify --deep --strict`.
- Required-release policy requires a `Developer ID Application` authority.
- Required-release policy requires the exact expected `TeamIdentifier` from `APPLE_TEAM_ID`.
- Required-release policy requires bundle identifier `com.dipjyotimetia.restura`.
- Required-release policy requires hardened-runtime signature flags.

The verifier returns structured non-sensitive evidence suitable for tests and CI logs. It never prints certificate payloads or secret values.

After packaging, the macOS release job will inspect the exact ZIP/DMG artifacts that are about to be uploaded. It will verify the ZIP's contained app identity and validate the notarization ticket/stapling on the distributable surface supported by Apple's tools. These checks run before the GitHub release becomes public.

## Updater lifecycle and error model

The intended lifecycle remains:

`checking -> available -> downloading -> validating -> downloaded -> installing`

Terminal failures retain the phase that failed. At minimum the renderer must distinguish:

- Check/network failure, which remains quiet for automatic background checks.
- Download failure, which offers retry.
- Validation failure after download, which remains visible and does not offer restart.
- Install/restart invocation failure, which remains visible and offers recovery guidance.

The main process will not report an update as restart-ready until the platform updater has completed the readiness event required by Electron Updater. Restart remains guarded by the trusted IPC validator and calls `quitAndInstall` only from a genuinely downloaded state.

## Renderer behavior

The desktop update notification will:

- Preserve silent handling for routine background check failures.
- Show a persistent actionable message for download, validation, or install failures.
- Avoid treating a post-download validation error as background noise.
- Offer Retry when another update check/download can recover.
- Offer a link to the trusted GitHub release for manual recovery.
- Hide or disable Restart unless the current main-process state is `downloaded`.
- Use user-facing copy without exposing cache paths, stack traces, or implementation details.

## Tests

Implementation follows red-green-refactor TDD. New regression tests must fail against the v1.6.0 code before production edits.

Required coverage:

- The trusted desktop release block contains both PR overrides with the same full predicate.
- Stable-release signature verification rejects ad-hoc signatures.
- Stable-release verification rejects the wrong Developer ID team, bundle identifier, or runtime flags.
- Development verification still permits ad-hoc builds without claiming they are verified.
- Post-download validation errors remain visible in the renderer.
- Restart is not offered after a terminal updater error.
- Retry and manual recovery actions invoke the correct APIs.
- Release publication cannot proceed unless the signed macOS verification step succeeds.
- Existing updater configuration, download, cancellation, and replay behavior remains covered.

## Verification gates

Before publication:

1. Focused updater, signature, UI, and workflow tests pass.
2. `npm run electron:compile` passes.
3. `npm run validate` passes.
4. The release workflow succeeds on macOS, Windows, and Linux.
5. The public v1.6.1 metadata and artifact hashes are downloaded and independently checked.
6. The public macOS ZIP app has the expected Developer ID authority, TeamIdentifier, bundle identifier, and hardened runtime.
7. The macOS distributable passes notarization/stapling verification.
8. Installed signed v1.5.0 discovers, downloads, validates, installs, restarts into, and reports v1.6.1.

Windows and Linux artifact/metadata checks remain required. A real N-1 to N install/relaunch smoke should be added to their release runners, but the emergency release is not allowed to claim those platform journeys were exercised unless they actually run.

## Release and recovery policy

v1.6.1 will be created only after the repair branch is reviewed, merged, and all local gates pass. The standard release workflow remains the publication authority.

If publication fails before external surfaces are published, use the existing candidate-SHA recovery. If only desktop artifacts fail while the release remains a draft, use `repair_release_tag`. Do not republish npm, Docker, or web unnecessarily.

If the production release becomes partially public in a state the documented recovery flow cannot safely repair, stop and report the exact external state before taking destructive release actions. Do not delete releases, tags, or attestations without a specific recovery decision.

## Success criteria

The repair is complete only when:

- v1.6.1 is public and immutable.
- Its stable updater metadata points to the verified signed artifacts.
- The macOS v1.5.0 to v1.6.1 update and relaunch succeeds.
- A validation failure is actionable rather than silent.
- The release workflow cannot publish another ad-hoc stable macOS updater artifact.
- All repository validation gates are green and the working tree is clean.
