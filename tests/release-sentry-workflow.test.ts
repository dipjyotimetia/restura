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
    expect(workflow).toContain('peter-evans/create-pull-request@');
    expect(workflow).toContain('actions/create-github-app-token@');
    expect(workflow).toContain('RELEASE_PR_APP_ID');
    expect(workflow).toContain('RELEASE_PR_APP_PRIVATE_KEY');
    expect(workflow).toContain('token: ${{ steps.release-pr-token.outputs.token }}');
    expect(workflow).toContain('sign-commits: true');
    expect(workflow).toContain(
      'add-paths: |\n            package.json\n            package-lock.json\n            cli/package.json\n            extension/vscode/package.json'
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
      "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.merge_commit_sha || github.sha }}"
    );
    expect(workflow).toContain('CLI_VERSION');
    expect(workflow).toContain('Root package version');
    expect(workflow).not.toContain('recover_stable_release_sha');
    expect(workflow).not.toContain('publish_existing_stable');
  });

  it('requires desktop Sentry secrets before stable releases', () => {
    const preflightBlock = workflow.slice(
      workflow.indexOf('Validate stable release secrets'),
      workflow.indexOf('- uses: actions/checkout@')
    );

    expect(preflightBlock).toContain('SENTRY_DSN');
    expect(preflightBlock).toContain('SENTRY_AUTH_TOKEN');
    expect(preflightBlock).toContain('SENTRY_ORG');
    expect(preflightBlock).toContain('SENTRY_PROJECT');
    expect(preflightBlock).toContain(
      'for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID WORKER_PROXY_TOKEN SENTRY_DSN SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_PROJECT'
    );
    // restura-cli publishes through npm trusted publishing (OIDC); no npm token
    // is read anywhere in the release workflow.
    expect(workflow).not.toContain('secrets.NPM_TOKEN');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
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

  it('keeps the smoke event out of the production environment', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/sentry-smoke.mjs'), 'utf8');

    expect(script).toContain("environment: 'ci-smoke'");
    expect(script).not.toContain("environment: 'production'");
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

  it('publishes npm, Docker, and web only after desktop installers succeed', () => {
    const needsOf = (job: string) => {
      const block = workflow.slice(workflow.indexOf(`\n  ${job}:`));
      return block.match(/^ {4}needs: \[([^\]]+)\]/m)?.[1];
    };
    // Nothing irreversible ships before the installers are signed AND attested.
    for (const job of ['build-cli', 'publish-docker', 'deploy-web']) {
      expect(needsOf(job), `${job} needs`).toBe('release, desktop, attest-desktop');
    }
    // publish-cli only ever publishes the tarball build-cli packed.
    expect(needsOf('publish-cli')).toBe('release, build-cli');
    expect(needsOf('attest-desktop')).toBe('desktop');
    expect(needsOf('attest-image')).toBe('publish-docker');
    expect(workflow).not.toContain('repair_release_tag');
    expect(workflow).not.toContain('is_repair');
  });

  it('retries only unpublished stable releases from main HEAD', () => {
    expect(workflow).toContain('retry_release_tag:');
    const retryBlock = workflow.slice(
      workflow.indexOf('- name: Clear unpublished release for retry'),
      workflow.indexOf('- name: Validate tag does not exist')
    );
    expect(retryBlock).toContain("if: ${{ inputs.retry_release_tag != '' }}");
    expect(retryBlock).toContain('npm view "${CLI_NAME}@${ACTUAL_TAG#v}" version');
    expect(retryBlock).toContain('--json isDraft --jq .isDraft');
    expect(retryBlock).toContain('gh release delete "$ACTUAL_TAG" --yes');
    expect(retryBlock).toContain('repos/${GITHUB_REPOSITORY}/git/refs/tags/${ACTUAL_TAG}');
    expect(retryBlock).toContain('steps.release-tag-token.outputs.token');
    expect(retryBlock).not.toContain('secrets.GITHUB_TOKEN');
    expect(retryBlock).not.toContain('--cleanup-tag');
    expect(workflow).toContain("does not match main's package.json version");
  });

  it('creates and deletes v* tags with the restura-bot App, not GITHUB_TOKEN', () => {
    const releaseJob = workflow.slice(
      workflow.indexOf('\n  release:'),
      workflow.indexOf('\n  desktop:')
    );
    expect(releaseJob).toContain('contents: read');
    expect(releaseJob).not.toMatch(/^\s+contents: write\s*$/m);
    expect(releaseJob).toContain('id: release-tag-token');
    expect(releaseJob).toContain('permission-contents: write');
    expect(releaseJob).not.toContain('permission-pull-requests:');
    expect(releaseJob).toContain('persist-credentials: false');
    expect(releaseJob).not.toContain('persist-credentials: true');
    expect(releaseJob).not.toContain('softprops/action-gh-release');
    expect(releaseJob).not.toContain('git push origin "${ACTUAL_TAG}"');
    expect(releaseJob).not.toContain('x-access-token:${');

    const push = releaseJob.slice(
      releaseJob.indexOf('- name: Tag and push'),
      releaseJob.indexOf('- name: Compute changelog range')
    );
    expect(push).toContain('APP_TOKEN: ${{ steps.release-tag-token.outputs.token }}');
    expect(push).toContain('GIT_ASKPASS="$askpass"');
    expect(push).toContain('x-access-token');
    expect(push).toContain('printf "%s\\n" "$APP_TOKEN"');
    expect(push).toContain('creations being restricted');
    expect(push).toContain('tag-ruleset-rejected "$ACTUAL_TAG" create');

    const notes = releaseJob.slice(
      releaseJob.indexOf('- name: Generate release notes'),
      releaseJob.indexOf('- name: Download SBOM')
    );
    expect(notes).not.toContain('release-tag-token');
    expect(notes).not.toContain('APP_TOKEN');

    const create = releaseJob.slice(releaseJob.indexOf('- name: Create GitHub release'));
    expect(create).toContain('GH_TOKEN: ${{ steps.release-tag-token.outputs.token }}');
    expect(create).toContain('gh "${args[@]}"');
    expect(create).toContain('--verify-tag');
    expect(create).toContain('--draft');
  });

  it('refuses a normal dispatch that would skip an unpublished stable version', () => {
    const guard = workflow.slice(
      workflow.indexOf('- name: Refuse to skip an unpublished stable version'),
      workflow.indexOf('- name: Validate stable release candidate')
    );
    expect(guard).toContain(
      "if: ${{ github.event_name == 'workflow_dispatch' && inputs.retry_release_tag == '' }}"
    );
    expect(guard).toContain('npm view "${CLI_NAME}@${CURRENT}" version');
    expect(guard).toContain('unpublished-guard');
    expect(guard).not.toContain('secrets.');

    const appCreds = workflow.slice(
      workflow.indexOf('- name: Validate release App credentials'),
      workflow.indexOf('- name: Require main branch')
    );
    expect(appCreds).toContain('RELEASE_PR_APP_ID');
    expect(appCreds).toContain('RELEASE_PR_APP_PRIVATE_KEY');
    expect(appCreds).not.toContain('retry_release_tag');
  });

  it('computes release versions from package.json instead of a tag-scanning action', () => {
    expect(workflow).not.toContain('anothrNick');
    expect(workflow).toContain('node scripts/release-version.mjs next "$RELEASE_BUMP"');
    expect(workflow).toContain(
      'node scripts/release-version.mjs next "$RELEASE_BUMP" "$PRERELEASE_IDENTIFIER"'
    );
  });

  it('reuses dispatch validation only for a version-only merged candidate', () => {
    expect(workflow).toContain('<!-- restura:validated_sha=${{ github.sha }} -->');
    const reuseBlock = workflow.slice(
      workflow.indexOf('- name: Reuse dispatch validation'),
      workflow.indexOf('- name: Validate application')
    );
    expect(reuseBlock).toContain("if: ${{ github.event_name == 'pull_request' }}");
    expect(reuseBlock).toContain('git merge-base --is-ancestor "$VALIDATED_SHA" origin/main');
    expect(reuseBlock).toContain('node scripts/release-version.mjs version-only-diff "$VERSION"');
    expect(reuseBlock).toContain("echo 'skip=false'");
    const validateBlock = workflow.slice(
      workflow.indexOf('- name: Validate application'),
      workflow.indexOf('  prepare-stable:')
    );
    expect(validateBlock).toContain("if: ${{ steps.reuse.outputs.skip != 'true' }}");
    expect(validateBlock).toContain('run: npm run validate');
  });

  it('generates release SBOMs with the npm 12-compatible CycloneDX CLI', () => {
    const sbomBlock = workflow.slice(
      workflow.indexOf('- name: Generate CycloneDX SBOM'),
      workflow.indexOf('- name: Create GitHub release')
    );

    // Lockfile-pinned generator, installed without install scripts — never a
    // floating `npx` download in a job that holds a contents:write token.
    expect(sbomBlock).toContain('npm ci --prefix .github/tools/cyclonedx --ignore-scripts');
    expect(sbomBlock).not.toMatch(/^\s*npx /m);
    expect(sbomBlock.match(/"\$CYCLONEDX" --package-lock-only --omit dev/g) ?? []).toHaveLength(2);
    const tool = JSON.parse(
      readFileSync(resolve(process.cwd(), '.github/tools/cyclonedx/package.json'), 'utf8')
    ) as { dependencies: Record<string, string> };
    // 7.x drops the bundled xmlbuilder2 path; pin a major that still works with
    // npm 12 and keep xmlbuilder2 explicit so --output-format XML succeeds.
    expect(tool.dependencies['@cyclonedx/cyclonedx-npm']).toMatch(/^7\.\d+\.\d+$/);
    expect(tool.dependencies.xmlbuilder2).toMatch(/^4\.\d+\.\d+$/);
  });
});
