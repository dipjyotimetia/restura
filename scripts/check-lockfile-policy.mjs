#!/usr/bin/env node
// Lockfile supply-chain policy (epic #1283: #1292, #1293).
//
// 1. Sources: every installed package resolves from the public npm registry
//    and carries an `integrity` hash, so `npm ci` can't silently pull a git URL
//    or an arbitrary tarball (neither has a registry signature).
// 2. Install scripts: every package the lockfile marks `hasInstallScript` has a
//    reviewed decision — `true` (approved) or `false` (denied), keyed by name
//    or by `name@<exact version>` — in the `allowScripts` field of the package.json next to that lockfile. npm 12
//    (pinned by scripts/verify-toolchain.mjs) already skips unapproved install
//    scripts, but only warns; this turns "a dependency bump added an install
//    script" into a CI failure that needs a reviewed package.json change.
//
// Usage: node scripts/check-lockfile-policy.mjs [lockfile ...]
// With no arguments, checks every committed lockfile (DEFAULT_LOCKFILES).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PREFIX = 'https://registry.npmjs.org/';
const NODE_MODULES = 'node_modules/';

export const DEFAULT_LOCKFILES = [
  'package-lock.json',
  'docs-site/package-lock.json',
  '.github/tools/claude-code/package-lock.json',
  '.github/tools/cyclonedx/package-lock.json',
  '.github/tools/openwiki/package-lock.json',
  '.github/tools/publish/package-lock.json',
];

export function packageNameFromKey(key) {
  return key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
}

/**
 * The name a registry tarball was published under, read from its `resolved`
 * URL (`<registry>/<name>/-/<file>.tgz`). npm's allowScripts gate keys on
 * this, not on the lockfile `name` field, which comes from the tarball's own
 * package.json and can claim any name.
 */
export function registryName(resolved) {
  if (typeof resolved !== 'string' || !resolved.startsWith(REGISTRY_PREFIX)) return undefined;
  const path = resolved.slice(REGISTRY_PREFIX.length);
  const end = path.indexOf('/-/');
  return end === -1 ? undefined : decodeURIComponent(path.slice(0, end));
}

/**
 * Whether `allowScripts` records a decision for this exact package version:
 * a name-only key (`pkg`), or a key pinned to exactly this version
 * (`pkg@1.2.3`, which npm narrows to that version). Range or multi-version
 * keys are not counted, so the check never treats a looser key as a review of
 * a version it may not cover.
 */
export function hasDecision(allowScripts, name, version) {
  const keys = Object.keys(allowScripts ?? {});
  return keys.includes(name) || (version !== undefined && keys.includes(`${name}@${version}`));
}

/**
 * Third-party entries only: skips the root (""), workspace folders (no
 * node_modules/ segment) and workspace symlinks (`link: true`).
 */
function* installedPackages(lock) {
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (!key.includes(NODE_MODULES) || value.link) continue;
    yield [key, value];
  }
}

export function checkLockfileSources(lock) {
  const findings = [];
  for (const [key, value] of installedPackages(lock)) {
    // Bundled dependencies ship inside their parent's tarball, which the
    // parent's own integrity hash already covers.
    if (value.inBundle) continue;
    if (typeof value.resolved !== 'string' || !value.resolved.startsWith(REGISTRY_PREFIX)) {
      findings.push({ key, resolved: value.resolved, problem: 'non-registry source' });
    }
    if (!value.integrity) {
      findings.push({ key, problem: 'missing integrity' });
    }
  }
  return findings;
}

export function checkInstallScripts(lock, allowScripts) {
  const findings = [];
  for (const [key, value] of installedPackages(lock)) {
    if (!value.hasInstallScript) continue;
    // Registry identity first (unspoofable); the folder name is the fallback
    // for the non-registry entries checkLockfileSources already rejects.
    const name = registryName(value.resolved) ?? packageNameFromKey(key);
    if (!hasDecision(allowScripts, name, value.version)) {
      findings.push({
        key,
        name,
        version: value.version,
        problem: 'install script has no allowScripts decision',
      });
    }
  }
  return findings;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
}

function main(argv) {
  const lockfiles = argv.length > 0 ? argv : DEFAULT_LOCKFILES;
  let failures = 0;
  for (const file of lockfiles) {
    const lock = readJson(file);
    const manifest = readJson(join(dirname(file), 'package.json'));
    const findings = [
      ...checkLockfileSources(lock),
      ...checkInstallScripts(lock, manifest.allowScripts),
    ];
    for (const f of findings) {
      const detail = f.resolved ? ` (${f.resolved})` : f.version ? `@${f.version}` : '';
      console.error(`${file}: ${f.problem}: ${f.key}${detail}`);
    }
    failures += findings.length;
  }
  if (failures > 0) {
    console.error(
      `\n${failures} lockfile policy finding(s). Review a new install script, then record the decision with` +
        ' `npm install-scripts approve|deny <pkg>` (writes allowScripts in package.json). Git/tarball' +
        ' dependencies and entries without an integrity hash are not allowed. See CONTRIBUTING.md → Adding a dependency.'
    );
    process.exit(1);
  }
  console.log(`Lockfile policy OK (${lockfiles.length} lockfile(s)).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
