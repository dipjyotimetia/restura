import { describe, expect, it } from 'vitest';

import { isVersionOnlyDiff, nextVersion } from '../../scripts/release-version.mjs';

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
