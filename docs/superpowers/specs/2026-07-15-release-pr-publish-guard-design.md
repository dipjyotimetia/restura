# Release PR publish guard

## Goal

Allow the trusted, merged `restura-bot` stable-release PR to publish desktop
installers while retaining Electron Builder's protection against arbitrary PR
builds.

## Current failure

The stable release workflow deliberately runs on a closed, merged
`release/prepare` PR owned by `restura-bot[bot]`. Electron Builder detects the
`pull_request` event and skips all publishing, so no updater metadata reaches
the draft GitHub release. The final verifier then fails.

## Design

The existing `preflight` job remains the authorization boundary: only a manual
dispatch or a merged `release/prepare` PR from `restura-bot[bot]` targeting
`main` may proceed. The desktop job will set `PUBLISH_FOR_PULL_REQUEST=true`
only for that already-authorized merged-bot event. Manual and beta releases
retain their existing behavior, and arbitrary/open/fork PRs cannot reach the
desktop job.

The workflow will also offer a narrow manual repair input for an existing draft
tag. That repair rebuilds only the desktop assets and promotes the existing
draft after updater metadata verification; it does not retag, republish npm,
or redeploy the web/Docker surfaces.

## Validation

Add workflow-structure tests that assert the PR-publish override is conditional
on the trusted merged-bot event and that repair excludes the unrelated release
surfaces. Run the focused test, YAML parsing, formatting, and diff checks.
