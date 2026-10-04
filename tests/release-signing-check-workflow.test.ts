import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release signing check workflow', () => {
  const workflow = readFileSync(
    resolve(process.cwd(), '.github/workflows/release-signing-check.yml'),
    'utf8'
  );

  it('signs with the production cert, fails closed, and never notarizes or publishes', () => {
    expect(workflow).toContain('runs-on: macos-latest');
    expect(workflow).toContain('CSC_LINK: ${{ secrets.CSC_LINK }}');
    expect(workflow).toContain('RESTURA_REQUIRE_SIGNED_MAC: "true"');
    expect(workflow).toContain(
      'npx electron-builder --mac --dir --publish never --config.mac.notarize=false --config.npmRebuild=false'
    );
    expect(workflow).not.toContain('--publish always');
    expect(workflow).toContain('permissions:\n  contents: read');
  });

  it('exposes signing secrets only to the signing step', () => {
    const beforeSign = workflow.slice(
      workflow.indexOf('- uses: actions/checkout@'),
      workflow.indexOf('- name: Sign and verify')
    );
    expect(beforeSign).not.toContain('secrets.CSC_');
  });

  it('runs on reviewed signing inputs but never on auto-merged lockfile bumps', () => {
    const paths = workflow.slice(workflow.indexOf('paths:'), workflow.indexOf('concurrency:'));
    expect(paths).not.toContain('package-lock.json');
    expect(paths).toContain('electron-builder.json');
    expect(paths).toContain('scripts/verify-electron-signature.mjs');
    expect(workflow).toContain('schedule:');
  });
});
