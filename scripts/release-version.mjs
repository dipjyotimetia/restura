#!/usr/bin/env node
// Release version helpers for .github/workflows/release.yml.
//
//   node scripts/release-version.mjs next <patch|minor|major> [prerelease-id]
//     Prints the next version computed from the root package.json.
//   git diff -U0 <a> <b> | node scripts/release-version.mjs version-only-diff <version>
//     Exits 0 only if every changed line sets a "version" field to <version>.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/;

export function nextVersion(current, bump, prereleaseIdentifier = '') {
  const match = STABLE.exec(current);
  if (!match) throw new Error(`Current version must be stable X.Y.Z; got '${current}'.`);
  let [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') [major, minor, patch] = [major + 1, 0, 0];
  else if (bump === 'minor') [minor, patch] = [minor + 1, 0];
  else if (bump === 'patch') patch += 1;
  else throw new Error(`Release bump must be patch, minor, or major; got '${bump}'.`);
  const next = `${major}.${minor}.${patch}`;
  if (!prereleaseIdentifier) return next;
  if (!IDENTIFIER.test(prereleaseIdentifier)) {
    throw new Error(`Invalid prerelease identifier '${prereleaseIdentifier}'.`);
  }
  return `${next}-${prereleaseIdentifier}`;
}

export function isVersionOnlyDiff(diff, version) {
  const changed = diff
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
  if (changed.length === 0) return false;
  const added = new RegExp(`^\\+\\s*"version": "${version.replaceAll('.', '\\.')}",?$`);
  const removed = /^-\s*"version": "[^"]+",?$/;
  return changed.every((line) => (line.startsWith('+') ? added.test(line) : removed.test(line)));
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'next') {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    console.log(nextVersion(version, args[0], args[1]));
    return 0;
  }
  if (command === 'version-only-diff') {
    return isVersionOnlyDiff(readFileSync(0, 'utf8'), args[0]) ? 0 : 1;
  }
  throw new Error('Usage: release-version.mjs next <bump> [id] | version-only-diff <version>');
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
