import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release workflow Sentry guardrails', () => {
  const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

  it('prepares stable releases through an App-authenticated pull request and never pushes main directly', () => {
    expect(workflow).toContain('Prepare stable release pull request');
    expect(workflow).toContain('peter-evans/create-pull-request@v8');
    expect(workflow).toContain('actions/create-github-app-token@v2');
    expect(workflow).toContain('RELEASE_PR_APP_ID');
    expect(workflow).toContain('RELEASE_PR_APP_PRIVATE_KEY');
    expect(workflow).toContain('token: ${{ steps.release-pr-token.outputs.token }}');
    expect(workflow).toContain('sign-commits: true');
    expect(workflow).toContain('publish_existing_stable');
    expect(workflow).not.toContain('git push origin HEAD:main');
  });

  it('pins stable publishing to an approved candidate commit with matching root and CLI versions', () => {
    expect(workflow).toContain('stable_release_sha');
    expect(workflow).toContain('git merge-base --is-ancestor "$STABLE_RELEASE_SHA" origin/main');
    expect(workflow).toContain(
      'ref: ${{ inputs.publish_existing_stable && inputs.stable_release_sha || github.sha }}'
    );
    expect(workflow).toContain('CLI_VERSION');
    expect(workflow).toContain('Root package version');
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

    expect(smokeBlock).toContain('if: ${{ !inputs.prerelease }}');
    expect(smokeBlock).toContain('SENTRY_DSN: ${{ secrets.SENTRY_DSN }}');
    expect(smokeBlock).toContain('npm run sentry:smoke');
  });
});
