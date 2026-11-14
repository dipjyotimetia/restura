#!/usr/bin/env node
// Release version helpers for .github/workflows/release.yml.
//
//   node scripts/release-version.mjs next <patch|minor|major> [prerelease-id]
//     Prints the next version computed from the root package.json.
//   git diff -U0 <a> <b> | node scripts/release-version.mjs version-only-diff <version>
//     Exits 0 only if every changed line sets a "version" field to <version>.
//   gh release list … --jq '.[].tagName' | node scripts/release-version.mjs unpublished-guard
//     Exits 1 when package.json is a stable version newer than every published
//     stable release, so a normal dispatch would skip that unpublished version.
//   node scripts/release-version.mjs tag-ruleset-rejected <tag> <create|delete>
//   node scripts/release-version.mjs release-already-exists <tag>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

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
  // Compare as plain strings: building a RegExp from `version` would let a
  // crafted argument change what the pattern matches.
  const added = `"version": "${version}"`;
  const removed = /^"version": "[^"]+"$/;
  return changed.every((line) => {
    const field = line.slice(1).trim().replace(/,$/, '');
    return line.startsWith('+') ? field === added : removed.test(field);
  });
}

function stableVersion(value) {
  const match = /^(?:v)?(\d+\.\d+\.\d+)$/.exec(String(value).trim());
  return match?.[1] ?? null;
}

function compareStable(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

// `published` is tag names or versions from public stable GitHub releases.
// Drafts, prereleases, and extension tags (vscode-v*, chrome-v*) do not count:
// a version that only exists as an orphan tag is still unpublished.
export function unpublishedStableAhead(current, published) {
  if (!STABLE.test(current)) {
    throw new Error(`Current version must be stable X.Y.Z; got '${current}'.`);
  }
  const versions = [];
  for (const entry of published) {
    const version = stableVersion(entry);
    if (version) versions.push(version);
  }
  if (versions.length === 0) return null;
  const latest = versions.reduce((best, version) =>
    compareStable(version, best) > 0 ? version : best
  );
  if (compareStable(current, latest) > 0) return { current, latest };
  return null;
}

export function formatUnpublishedGuard({ current, latest }) {
  return [
    `main is at ${current}, ahead of the latest published stable release ${latest}.`,
    `v${current} has not been published. A new version bump would skip it.`,
    'Publish the unpublished release from current main HEAD:',
    `  gh workflow run release.yml --ref main -f retry_release_tag=v${current}`,
    'Leave prerelease off. publish_docker stays off unless this release should push a GHCR image.',
    `A normal Release dispatch stays blocked until v${current} is published,`,
    `or until package.json is set back to ${latest} to abandon that version.`,
  ].join('\n');
}

export function formatTagRulesetRejection(tag, action) {
  const verb = action === 'delete' ? 'deleting' : 'creating';
  const lines = [
    `The v* tag ruleset rejected ${verb} ${tag}.`,
    'This step authenticates as the restura-bot GitHub App',
    '(RELEASE_PR_APP_ID / RELEASE_PR_APP_PRIVATE_KEY), not as github-actions[bot].',
    'Add that App to the tag ruleset bypass list:',
    `Settings → Rules → Rulesets → the ruleset that matches ${tag}.`,
    'The bypass has to cover creation, update, and deletion',
    'so a retry can remove an unpublished tag.',
    'Leave the ruleset in place. GitHub Actions (GITHUB_TOKEN) does not need a bypass.',
  ];
  if (STABLE_TAG.test(tag)) {
    lines.push(
      'After the App is on the bypass list, publish with:',
      `gh workflow run release.yml --ref main -f retry_release_tag=${tag}`
    );
  } else {
    lines.push(
      'After the App is on the bypass list, re-dispatch the prerelease.',
      'retry_release_tag accepts a stable vX.Y.Z only.'
    );
  }
  return lines.join('\n');
}

export function formatExistingRelease(tag) {
  if (!STABLE_TAG.test(tag)) {
    return [
      `${tag} already exists, so this run will not overwrite it.`,
      'Pick a new prerelease_identifier (for example beta.2).',
      'retry_release_tag accepts a stable vX.Y.Z only.',
    ].join('\n');
  }
  const version = tag.slice(1);
  return [
    `${tag} already has a git tag or a GitHub release, so this run will not overwrite it.`,
    'When that release is still unpublished (a draft, or a tag with no public release)',
    `and restura-cli@${version} is not on npm, publish it from current main HEAD:`,
    `  gh workflow run release.yml --ref main -f retry_release_tag=${tag}`,
    'The retry deletes the unpublished draft and tag as restura-bot,',
    'then tags the current main HEAD.',
    'A public release is immutable. Ship a new patch instead of retrying it.',
  ].join('\n');
}

// `io` is injected so the CLI paths are unit-testable without spawning node.
export function runCli(argv, io) {
  const [command, ...args] = argv;
  if (command === 'next') {
    const { version } = JSON.parse(io.read('package.json'));
    io.log(nextVersion(version, args[0], args[1]));
    return 0;
  }
  if (command === 'version-only-diff') {
    return isVersionOnlyDiff(io.read(0), args[0]) ? 0 : 1;
  }
  if (command === 'unpublished-guard') {
    const { version } = JSON.parse(io.read('package.json'));
    const published = io
      .read(0)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const ahead = unpublishedStableAhead(version, published);
    if (!ahead) return 0;
    io.log(formatUnpublishedGuard(ahead));
    return 1;
  }
  if (command === 'tag-ruleset-rejected') {
    const [tag, action] = args;
    if (!tag || (action !== 'create' && action !== 'delete')) {
      throw new Error('Usage: release-version.mjs tag-ruleset-rejected <tag> <create|delete>');
    }
    io.log(formatTagRulesetRejection(tag, action));
    return 0;
  }
  if (command === 'release-already-exists') {
    const [tag] = args;
    if (!tag) throw new Error('Usage: release-version.mjs release-already-exists <tag>');
    io.log(formatExistingRelease(tag));
    return 0;
  }
  throw new Error(
    [
      'Usage: release-version.mjs',
      'next <bump> [id]',
      'version-only-diff <version>',
      'unpublished-guard',
      'tag-ruleset-rejected <tag> <create|delete>',
      'release-already-exists <tag>',
    ].join(' | ')
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2), {
    read: (file) => readFileSync(file, 'utf8'),
    log: (line) => console.log(line),
  });
}
