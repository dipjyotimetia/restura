import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CI workflow', () => {
  const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

  it('does not fail validation when optional PR comment publishers are unavailable', () => {
    const commentSteps: Array<[start: string, end: string]> = [
      ['- name: Comment test results on PR', '- name: Vitest Coverage Report'],
      ['- name: Vitest Coverage Report', '- name: Upload coverage report'],
      ['- name: Comment preview URL on PR', '  # docs-site is NOT an npm workspace'],
    ];

    for (const [start, end] of commentSteps) {
      const step = workflow.slice(workflow.indexOf(start), workflow.indexOf(end));
      expect(step).toContain('continue-on-error: true');
    }
  });
});
