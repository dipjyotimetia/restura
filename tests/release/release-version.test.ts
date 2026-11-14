import { describe, expect, it } from 'vitest';

import {
  formatExistingRelease,
  formatTagRulesetRejection,
  formatUnpublishedGuard,
  isVersionOnlyDiff,
  nextVersion,
  runCli,
  unpublishedStableAhead,
} from '../../scripts/release-version.mjs';

describe('nextVersion', () => {
  it.each([
    ['1.12.1', 'patch', '1.12.2'],
    ['1.12.1', 'minor', '1.13.0'],
    ['1.12.1', 'major', '2.0.0'],
  ])('bumps %s by %s to %s', (current, bump, expected) => {
    expect(nextVersion(current, bump)).toBe(expected);
  });

  it('appends a prerelease identifier to the next stable version', () => {
    expect(nextVersion('1.12.1', 'patch', 'beta.1')).toBe('1.12.2-beta.1');
  });

  it('rejects non-stable current versions, unknown bumps, and bad identifiers', () => {
    expect(() => nextVersion('1.12.1-beta.1', 'patch')).toThrow(/stable/);
    expect(() => nextVersion('1.12', 'patch')).toThrow(/stable/);
    expect(() => nextVersion('1.12.1', 'prepatch')).toThrow(/bump/);
    expect(() => nextVersion('1.12.1', 'patch', 'beta 1')).toThrow(/identifier/);
  });
});

describe('isVersionOnlyDiff', () => {
  const versionBump = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -3 +3 @@',
    '-  "version": "1.12.1",',
    '+  "version": "1.12.2",',
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -3 +3 @@',
    '-  "version": "1.12.1",',
    '+  "version": "1.12.2",',
    '@@ -9 +9 @@',
    '-      "version": "1.12.1",',
    '+      "version": "1.12.2",',
  ].join('\n');

  it('accepts a diff that only sets version fields to the release version', () => {
    expect(isVersionOnlyDiff(versionBump, '1.12.2')).toBe(true);
  });

  it('treats the version argument literally, not as a pattern', () => {
    const bump = '-  "version": "1.12.1",\n+  "version": "1.12.2",';
    expect(isVersionOnlyDiff(bump, '1.12.2')).toBe(true);
    expect(isVersionOnlyDiff(bump, '1.12.?')).toBe(false);
    expect(isVersionOnlyDiff(bump, '1x12x2')).toBe(false);
    expect(isVersionOnlyDiff(bump, '.*')).toBe(false);
  });

  it('rejects an empty diff', () => {
    expect(isVersionOnlyDiff('', '1.12.2')).toBe(false);
  });

  it('rejects a dependency bump hidden in the lockfile', () => {
    const withDependency = `${versionBump}\n${[
      '@@ -900,3 +900,3 @@',
      '-      "version": "4.17.20",',
      '+      "version": "4.17.21",',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
    ].join('\n')}`;
    expect(isVersionOnlyDiff(withDependency, '1.12.2')).toBe(false);
  });

  it('rejects any non-version change', () => {
    const withCode = `${versionBump}\n${[
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-export const x = 1;',
      '+export const x = 2;',
    ].join('\n')}`;
    expect(isVersionOnlyDiff(withCode, '1.12.2')).toBe(false);
  });
});

function io(files: Record<string, string>) {
  const lines: string[] = [];
  return {
    lines,
    read: (file: string | number) => files[String(file)] ?? '',
    log: (line: string) => lines.push(line),
  };
}

describe('unpublishedStableAhead', () => {
  it('blocks a dispatch that would skip an unpublished stable version', () => {
    expect(unpublishedStableAhead('1.18.2', ['v1.18.0', 'v1.18.1'])).toEqual({
      current: '1.18.2',
      latest: '1.18.1',
    });
  });

  it('compares numeric semver, ignoring prerelease and extension tags', () => {
    expect(
      unpublishedStableAhead('1.10.0', ['v1.9.0', 'v1.18.2-beta.1', 'vscode-v1.2.3', 'chrome-v9'])
    ).toEqual({ current: '1.10.0', latest: '1.9.0' });
  });

  it('allows a normal bump once the current version is the latest published release', () => {
    expect(unpublishedStableAhead('1.18.1', ['1.18.1', 'v1.18.0'])).toBeNull();
  });

  it('allows the first release, when nothing stable has been published', () => {
    expect(unpublishedStableAhead('0.1.0', [])).toBeNull();
    expect(unpublishedStableAhead('0.1.0', ['v1.2.3-beta.1'])).toBeNull();
  });

  it('rejects a non-stable package.json version', () => {
    expect(() => unpublishedStableAhead('1.18.2-beta.1', ['v1.18.1'])).toThrow(/stable/);
  });

  it('prints the retry command and stays quiet when a bump is allowed', () => {
    const blocked = formatUnpublishedGuard({ current: '1.18.2', latest: '1.18.1' });
    expect(blocked).toContain(
      'gh workflow run release.yml --ref main -f retry_release_tag=v1.18.2'
    );
    expect(blocked).toContain('ahead of the latest published stable release 1.18.1');

    const fake = io({ 'package.json': '{"version":"1.18.2"}', '0': 'v1.18.1\nv1.18.0\n' });
    expect(runCli(['unpublished-guard'], fake)).toBe(1);
    expect(fake.lines.join('\n')).toContain('retry_release_tag=v1.18.2');

    const current = io({ 'package.json': '{"version":"1.18.1"}', '0': 'v1.18.1\n' });
    expect(runCli(['unpublished-guard'], current)).toBe(0);
    expect(current.lines).toEqual([]);
  });
});

describe('release recovery messages', () => {
  it('tells the operator to put restura-bot on the tag ruleset bypass list', () => {
    const created = formatTagRulesetRejection('v1.18.2', 'create');
    expect(created).toContain('rejected creating v1.18.2');
    expect(created).toContain('restura-bot GitHub App');
    expect(created).toContain('not as github-actions[bot]');
    expect(created).toContain('creation, update, and deletion');
    expect(created).toContain('retry_release_tag=v1.18.2');
    expect(created).toContain('GitHub Actions (GITHUB_TOKEN) does not need a bypass');

    const deleted = formatTagRulesetRejection('v1.18.3-beta.1', 'delete');
    expect(deleted).toContain('rejected deleting v1.18.3-beta.1');
    expect(deleted).toContain('retry_release_tag accepts a stable vX.Y.Z only');
  });

  it('points an existing stable tag at retry and a prerelease at a new identifier', () => {
    const stable = formatExistingRelease('v1.18.2');
    expect(stable).toContain('will not overwrite it');
    expect(stable).toContain('retry_release_tag=v1.18.2');
    expect(stable).toContain('restura-bot');
    expect(stable).toContain('public release is immutable');

    const beta = formatExistingRelease('v1.18.3-beta.1');
    expect(beta).toContain('prerelease_identifier');
    expect(beta).not.toContain('retry_release_tag=v1.18.3-beta.1');
  });
});

describe('runCli', () => {
  it('prints the next version from package.json', () => {
    const fake = io({ 'package.json': '{"version":"1.12.1"}' });
    expect(runCli(['next', 'minor', 'beta.2'], fake)).toBe(0);
    expect(fake.lines).toEqual(['1.13.0-beta.2']);
  });

  it('exits 0 for a version-only diff on stdin and 1 otherwise', () => {
    const diff = '-  "version": "1.12.1",\n+  "version": "1.12.2",';
    expect(runCli(['version-only-diff', '1.12.2'], io({ '0': diff }))).toBe(0);
    expect(runCli(['version-only-diff', '1.12.3'], io({ '0': diff }))).toBe(1);
  });

  it('rejects unknown commands', () => {
    expect(() => runCli(['bogus'], io({}))).toThrow(/Usage/);
  });
});
