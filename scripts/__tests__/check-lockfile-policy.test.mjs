import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkInstallScripts,
  checkLockfileSources,
  hasDecision,
  packageNameFromKey,
  registryName,
} from '../check-lockfile-policy.mjs';

const REGISTRY = 'https://registry.npmjs.org';

function entry(name, extra = {}) {
  return {
    version: '1.0.0',
    resolved: `${REGISTRY}/${name}/-/${name.split('/').pop()}-1.0.0.tgz`,
    integrity: 'sha512-AAAA',
    ...extra,
  };
}

function lockfile(packages) {
  return {
    lockfileVersion: 3,
    packages: { '': { name: 'root', hasInstallScript: true }, ...packages },
  };
}

test('packageNameFromKey takes the last node_modules segment, keeping scopes', () => {
  assert.equal(packageNameFromKey('node_modules/esbuild'), 'esbuild');
  assert.equal(
    packageNameFromKey('node_modules/@grpc/proto-loader/node_modules/protobufjs'),
    'protobufjs'
  );
  assert.equal(packageNameFromKey('node_modules/@sentry/cli'), '@sentry/cli');
});

test('checkLockfileSources accepts registry tarballs with integrity', () => {
  const lock = lockfile({ 'node_modules/a': entry('a'), 'node_modules/@s/b': entry('@s/b') });
  assert.deepEqual(checkLockfileSources(lock), []);
});

test('checkLockfileSources skips the root, workspace folders, workspace links and bundled deps', () => {
  const lock = lockfile({
    cli: { name: 'restura-cli', version: '1.0.0' },
    'node_modules/restura-cli': { resolved: 'cli', link: true },
    'node_modules/parent': entry('parent', { bundleDependencies: ['tslib'] }),
    'node_modules/parent/node_modules/tslib': { version: '2.8.1', inBundle: true },
  });
  assert.deepEqual(checkLockfileSources(lock), []);
});

test('checkLockfileSources flags a git dependency and a missing integrity, naming each entry', () => {
  const lock = lockfile({
    'node_modules/from-git': {
      version: '1.0.0',
      resolved: 'git+https://github.com/evil/from-git.git#0123456789abcdef0123456789abcdef01234567',
    },
    'node_modules/no-hash': entry('no-hash', { integrity: undefined }),
    'node_modules/tarball': entry('tarball', {
      resolved: 'https://evil.example/tarball-1.0.0.tgz',
    }),
  });
  const findings = checkLockfileSources(lock);
  assert.deepEqual(
    findings.map((f) => [f.key, f.problem]),
    [
      ['node_modules/from-git', 'non-registry source'],
      ['node_modules/from-git', 'missing integrity'],
      ['node_modules/no-hash', 'missing integrity'],
      ['node_modules/tarball', 'non-registry source'],
    ]
  );
});

test('checkLockfileSources rejects a lookalike registry host', () => {
  const lock = lockfile({
    'node_modules/a': entry('a', {
      resolved: 'https://registry.npmjs.org.evil.example/a/-/a-1.0.0.tgz',
    }),
  });
  assert.equal(checkLockfileSources(lock).length, 1);
});

test('registryName reads the published name from a registry tarball URL', () => {
  assert.equal(registryName('https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz'), 'esbuild');
  assert.equal(
    registryName('https://registry.npmjs.org/@sentry/cli/-/cli-3.8.2.tgz'),
    '@sentry/cli'
  );
  assert.equal(
    registryName('https://registry.npmjs.org/@sentry%2fcli/-/cli-3.8.2.tgz'),
    '@sentry/cli'
  );
  assert.equal(registryName('git+https://github.com/x/y.git'), undefined);
});

test('hasDecision accepts a name-only key or the exact pinned version, nothing looser', () => {
  const allow = { esbuild: true, 'workerd@1.2.3': true, '@s/x@^1': false, 'denied@2.0.0': false };
  assert.equal(hasDecision(allow, 'esbuild', '9.9.9'), true);
  assert.equal(hasDecision(allow, 'workerd', '1.2.3'), true);
  assert.equal(hasDecision(allow, 'workerd', '1.2.4'), false);
  assert.equal(hasDecision(allow, 'denied', '2.0.0'), true);
  // Ranges are not treated as a reviewed decision for a specific version.
  assert.equal(hasDecision(allow, '@s/x', '1.0.0'), false);
  assert.equal(hasDecision(allow, 'other', '1.0.0'), false);
});

test('checkInstallScripts passes approved or denied packages and ignores our own root/workspaces', () => {
  const lock = lockfile({
    cli: { name: 'restura-cli', hasInstallScript: true },
    'node_modules/esbuild': entry('esbuild', { hasInstallScript: true }),
    'node_modules/x/node_modules/esbuild': entry('esbuild', { hasInstallScript: true }),
    'node_modules/denied': entry('denied', { hasInstallScript: true }),
    'node_modules/plain': entry('plain'),
  });
  assert.deepEqual(checkInstallScripts(lock, { esbuild: true, 'denied@1.0.0': false }), []);
});

test('checkInstallScripts flags an install script with no allowScripts decision', () => {
  const lock = lockfile({
    'node_modules/esbuild': entry('esbuild', { hasInstallScript: true }),
    'node_modules/sneaky': entry('sneaky', { hasInstallScript: true }),
  });
  assert.deepEqual(checkInstallScripts(lock, { esbuild: true }), [
    {
      key: 'node_modules/sneaky',
      name: 'sneaky',
      version: '1.0.0',
      problem: 'install script has no allowScripts decision',
    },
  ]);
});

test('checkInstallScripts keys on the published name, not a spoofable `name` field', () => {
  // A package published as `evil` whose own package.json claims "esbuild":
  // npm's allowScripts gate keys on the registry name, so must this check.
  const lock = lockfile({
    'node_modules/esbuild': entry('evil', { name: 'esbuild', hasInstallScript: true }),
  });
  assert.deepEqual(
    checkInstallScripts(lock, { esbuild: true }).map((f) => f.name),
    ['evil']
  );
});

test('checkInstallScripts does not count an approval pinned to another version', () => {
  const lock = lockfile({ 'node_modules/esbuild': entry('esbuild', { hasInstallScript: true }) });
  assert.equal(checkInstallScripts(lock, { 'esbuild@0.0.1': true }).length, 1);
});
