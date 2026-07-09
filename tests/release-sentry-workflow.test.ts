import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release workflow Sentry guardrails', () => {
  const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

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
