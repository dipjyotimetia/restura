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
      'npx electron-builder --mac --dir --publish never --config.mac.notarize=false'
    );
    expect(workflow).not.toContain('--publish always');
    expect(workflow).toContain('permissions:\n  contents: read');
  });

  it('runs when electron-builder or signing inputs change on main', () => {
    const paths = workflow.slice(workflow.indexOf('paths:'), workflow.indexOf('concurrency:'));
    expect(paths).toContain('package-lock.json');
    expect(paths).toContain('electron-builder.json');
    expect(paths).toContain('scripts/verify-electron-signature.mjs');
    expect(workflow).toContain('schedule:');
  });
});
