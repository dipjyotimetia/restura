import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('docs-site production deployment', () => {
  const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  const docsJob = workflow.slice(workflow.indexOf('  docs:\n'));

  it('deploys docs after a main push only when docs-site changed', () => {
    expect(docsJob).toContain('fetch-depth: 0');
    expect(docsJob).toContain('id: docs-production-deploy');
    expect(docsJob).toContain('GITHUB_EVENT_NAME: ${{ github.event_name }}');
    expect(docsJob).toContain('GITHUB_REF: ${{ github.ref }}');
    expect(docsJob).toContain('GITHUB_EVENT_BEFORE: ${{ github.event.before }}');
    expect(docsJob).toContain('git diff --quiet "$GITHUB_EVENT_BEFORE" "$GITHUB_SHA" -- docs-site');
    expect(docsJob).toContain('deploy=true');
    expect(docsJob).toContain('deploy=false');
    expect(docsJob).toContain("if: ${{ steps.docs-production-deploy.outputs.deploy == 'true' }}");
    expect(docsJob).toContain(
      'pages deploy docs-site/dist --project-name=restura-docs --branch=main'
    );
  });
});
