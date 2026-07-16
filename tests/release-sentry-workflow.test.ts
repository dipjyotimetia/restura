import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function workflowExpressionFor(source: string, key: string): string {
  const match = source.match(new RegExp(`^\\s*${key}:\\s*\\$\\{\\{([^\\n]+)\\}\\}`, 'm'));
  expect(match, `${key} must be defined`).not.toBeNull();
  return match?.[1]?.replace(/\\s+/g, ' ').trim() ?? '';
}

describe('release workflow Sentry guardrails', () => {
  const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

  it('merges release candidates directly through the App bypass without waiting for candidate CI', () => {
    expect(workflow).toContain('Prepare stable release pull request');
    expect(workflow).toContain('peter-evans/create-pull-request@v8');
    expect(workflow).toContain('actions/create-github-app-token@v2');
    expect(workflow).toContain('RELEASE_PR_APP_ID');
    expect(workflow).toContain('RELEASE_PR_APP_PRIVATE_KEY');
    expect(workflow).toContain('token: ${{ steps.release-pr-token.outputs.token }}');
    expect(workflow).toContain('sign-commits: true');
    expect(workflow).toContain(
      'add-paths: |\n            package.json\n            package-lock.json\n            cli/package.json\n            extension/chrome/package.json\n            extension/vscode/package.json'
    );
    expect(workflow).toContain('Merge release candidate through bot bypass');
    expect(workflow).toContain('gh pr merge --squash --admin "$PR_URL"');
    expect(workflow).not.toContain('workflow_run:');
    expect(workflow).not.toContain('gh pr merge --auto');
    expect(workflow).toContain("github.event.pull_request.user.login == 'restura-bot[bot]'");
    expect(workflow).not.toContain('git push origin HEAD:main');
  });

  it('publishes only the merged release-bot candidate commit with matching root and CLI versions', () => {
    expect(workflow).toContain('pull_request:\n    branches: [main]\n    types: [closed]');
    expect(workflow).toContain("github.event.pull_request.head.ref == 'release/prepare'");
    expect(workflow).toContain('github.event.pull_request.merge_commit_sha');
    expect(workflow).toContain(
      "ref: ${{ inputs.repair_release_tag || github.event_name == 'pull_request' && github.event.pull_request.merge_commit_sha || inputs.recover_stable_release_sha || github.sha }}"
    );
    expect(workflow).toContain('CLI_VERSION');
    expect(workflow).toContain('Root package version');
    expect(workflow).toContain('recover_stable_release_sha');
    expect(workflow).not.toContain('publish_existing_stable');
  });

  it('requires desktop Sentry secrets before stable releases', () => {
    const preflightBlock = workflow.slice(
      workflow.indexOf('Validate stable release secrets'),
      workflow.indexOf('- uses: actions/checkout@v7')
    );

    expect(preflightBlock).toContain('SENTRY_DSN');
    expect(preflightBlock).toContain('SENTRY_AUTH_TOKEN');
    expect(preflightBlock).toContain('SENTRY_ORG');
    expect(preflightBlock).toContain('SENTRY_PROJECT');
    expect(preflightBlock).toContain(
      'NPM_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID WORKER_PROXY_TOKEN SENTRY_DSN SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_PROJECT'
    );
  });

  it('smoke tests Sentry ingest before stable installers publish', () => {
    const smokeBlock = workflow.slice(
      workflow.indexOf('Smoke test Sentry ingest'),
      workflow.indexOf('Install Linux packaging tools')
    );

    expect(smokeBlock).toContain("if: ${{ needs.release.outputs.is_prerelease == 'false' }}");
    expect(smokeBlock).toContain('SENTRY_DSN: ${{ secrets.SENTRY_DSN }}');
    expect(smokeBlock).toContain('npm run sentry:smoke');
  });

  it('permits Electron publishing only for the trusted merged release candidate', () => {
    const desktopPublishBlock = workflow.slice(
      workflow.indexOf('- name: Build + publish installers'),
      workflow.indexOf('- name: Attest installer provenance')
    );

    expect(desktopPublishBlock).toContain('PUBLISH_FOR_PULL_REQUEST:');
    expect(desktopPublishBlock).toContain("github.event_name == 'pull_request'");
    expect(desktopPublishBlock).toContain('github.event.pull_request.merged');
    expect(desktopPublishBlock).toContain("github.event.pull_request.base.ref == 'main'");
    expect(desktopPublishBlock).toContain(
      "github.event.pull_request.head.ref == 'release/prepare'"
    );
    expect(desktopPublishBlock).toContain(
      "github.event.pull_request.user.login == 'restura-bot[bot]'"
    );
  });

  it('uses the same trusted merged release candidate predicate for signing and publishing', () => {
    const publishPredicate = workflowExpressionFor(workflow, 'PUBLISH_FOR_PULL_REQUEST');
    const signingPredicate = workflowExpressionFor(workflow, 'CSC_FOR_PULL_REQUEST');

    expect(signingPredicate).toBe(publishPredicate);
    expect(publishPredicate).toContain("github.event_name == 'pull_request'");
    expect(publishPredicate).toContain('github.event.pull_request.merged');
    expect(publishPredicate).toContain("github.event.pull_request.base.ref == 'main'");
    expect(publishPredicate).toContain("github.event.pull_request.head.ref == 'release/prepare'");
    expect(publishPredicate).toContain(
      "github.event.pull_request.user.login == 'restura-bot[bot]'"
    );
    expect(publishPredicate).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository'
    );
  });

  it('requires Developer ID signing for stable macOS installers', () => {
    const desktopPublishBlock = workflow.slice(
      workflow.indexOf('- name: Build + publish installers'),
      workflow.indexOf('- name: Attest installer provenance')
    );

    expect(desktopPublishBlock).toContain(
      "RESTURA_REQUIRE_SIGNED_MAC: ${{ runner.os == 'macOS' && needs.release.outputs.is_prerelease == 'false' }}"
    );
  });

  it('verifies the packaged stable macOS updater artifact before attestation', () => {
    const buildIndex = workflow.indexOf('- name: Build + publish installers');
    const verifyIndex = workflow.indexOf('- name: Verify signed macOS release artifacts');
    const attestIndex = workflow.indexOf('- name: Attest installer provenance');

    expect(buildIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(buildIndex);
    expect(attestIndex).toBeGreaterThan(verifyIndex);

    const verificationBlock = workflow.slice(verifyIndex, attestIndex);
    expect(verificationBlock).toContain(
      "if: ${{ runner.os == 'macOS' && needs.release.outputs.is_prerelease == 'false' }}"
    );
    expect(verificationBlock).toContain('set -euo pipefail');
    expect(verificationBlock).toContain('test -s "$ZIP"');
    expect(verificationBlock).toContain('test -s "$DMG"');
    expect(verificationBlock).toContain('ditto -x -k "$ZIP" "$WORK_DIR"');
    expect(verificationBlock).toContain('node scripts/verify-electron-signature.mjs');
    expect(verificationBlock).toContain('--require-developer-id');
    expect(verificationBlock).toContain('--team-id "$APPLE_TEAM_ID"');
    expect(verificationBlock).toContain('--bundle-id "com.dipjyotimetia.restura"');
    expect(verificationBlock).toContain('xcrun stapler validate "$WORK_DIR/Restura.app"');

    expect(workflow).toContain("needs.desktop.result == 'success'");
  });

  it('repairs existing draft releases without republishing other distribution surfaces', () => {
    expect(workflow).toContain('repair_release_tag:');
    expect(workflow).toContain('is_repair: ${{ steps.context.outputs.is_repair }}');
    expect(workflow).toContain("needs.release.outputs.is_repair != 'true'");
    expect(workflow).toContain("needs.release.outputs.is_repair == 'true'");
  });

  it('requires the full merge gate on the exact release candidate SHA', () => {
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('checks: read');
    expect(workflow).toContain('id: candidate');
    expect(workflow).toContain('candidate_sha=');
    expect(workflow).toContain('node scripts/ci/wait-for-check-run.mjs');
    expect(workflow).toContain('--name merge-gate');
    expect(workflow).toContain('--sha "${{ steps.candidate.outputs.candidate_sha }}"');
  });

  it('propagates the authorized SHA through tag creation and every publisher', () => {
    expect(workflow).toContain('candidate_sha: ${{ steps.candidate.outputs.candidate_sha }}');
    expect(workflow).toContain('candidate_sha: ${{ needs.preflight.outputs.candidate_sha }}');
    expect(workflow).toContain('ref: ${{ needs.preflight.outputs.candidate_sha }}');
    expect(workflow.match(/ref: \$\{\{ needs\.release\.outputs\.candidate_sha \}\}/g)).toHaveLength(
      4
    );
    expect(workflow).not.toContain('ref: ${{ needs.release.outputs.actual_tag }}');
    expect(workflow).toContain('Verify tag points to authorized candidate SHA');
  });
});
