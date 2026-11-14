import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import asar from '@electron/asar';
import {
  findDevOnlyRuntimeRequires,
  findMissingRuntimeRequires,
  isShippedResolution,
  literalSpecifiers,
  packageNameFromSpecifier,
  verifyPackagedMainRequires,
} from '../verify-packaged-main-requires.mjs';

function writeApp(root, files) {
  mkdirSync(root, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

function specifiers(result) {
  return result.missing.map((item) => item.specifier);
}

test('literalSpecifiers ignores comments, builtins stay visible, variables are not deps', () => {
  const source = `
    /* require('@commented/pkg') */
    require("node:fs");
    require('./local');
    require(someVariable);
    import("@dynamic/pkg");
  `;
  assert.deepEqual(literalSpecifiers(source), ['node:fs', './local', '@dynamic/pkg']);
});

test('packageNameFromSpecifier keeps the package, not the subpath', () => {
  assert.equal(
    packageNameFromSpecifier('@modelcontextprotocol/server/stdio'),
    '@modelcontextprotocol/server'
  );
  assert.equal(packageNameFromSpecifier('electron-log/main'), 'electron-log');
  assert.equal(packageNameFromSpecifier('zod'), 'zod');
});

test('flags a main or preload import that is only a devDependency', () => {
  const app = mkdtempSync(path.join(tmpdir(), 'restura-devdep-'));
  try {
    writeApp(app, {
      'package.json': JSON.stringify({
        main: 'main.js',
        dependencies: { shipped: '^1.0.0' },
        devDependencies: { 'only-dev': '^1.0.0', shipped: '^1.0.0' },
      }),
      'main.js': "require('./feature.js');\nrequire('shipped');\n",
      'feature.js': "require('only-dev/extra');\n",
    });
    const hits = findDevOnlyRuntimeRequires(app);
    assert.deepEqual(
      hits.map((hit) => hit.packageName),
      ['only-dev']
    );
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('a resolution outside the app directory is not shipped', () => {
  const app = path.resolve('/tmp/restura-app');
  assert.equal(isShippedResolution(app, path.join(app, 'node_modules', 'pkg', 'index.js')), true);
  assert.equal(isShippedResolution(app, '/workspace/node_modules/pkg/index.js'), false);
  assert.equal(isShippedResolution(app, 'node:fs'), true);
});

test('flags a main-process require that resolves only from a parent install', () => {
  // tmp/ is inside this repo, so Node's parent walk finds the real
  // @modelcontextprotocol/node in /workspace/node_modules. That is exactly the
  // dev-install false green #1353 hid: the package was present for `npm test`
  // and missing from app.asar.
  const scratch = path.join(process.cwd(), 'tmp');
  mkdirSync(scratch, { recursive: true });
  const app = mkdtempSync(path.join(scratch, 'packaged-requires-'));
  try {
    writeApp(app, {
      'package.json': JSON.stringify({ main: 'main.js' }),
      'main.js': "require('./handlers/mcp-control-server.js');\n",
      'handlers/mcp-control-server.js':
        "require('@modelcontextprotocol/node');\nrequire('node:fs');\nrequire('electron');\n",
      'node_modules/shipped/package.json': JSON.stringify({ main: 'index.js' }),
      'node_modules/shipped/index.js': 'module.exports = {};\n',
      'feature.js': "require('shipped');\n",
    });
    writeFileSync(
      path.join(app, 'main.js'),
      "require('./handlers/mcp-control-server.js');\nrequire('./feature.js');\n"
    );
    const result = findMissingRuntimeRequires(app);
    assert.deepEqual(specifiers(result), ['@modelcontextprotocol/node']);
    assert.deepEqual(result.checked, ['shipped']);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('a symlinked app root still counts packages inside it as shipped', () => {
  // macOS os.tmpdir() is /var/folders, a symlink to /private/var/folders.
  // require.resolve returns the real path, so the checker must realpath the
  // extract dir or every in-archive module looks external.
  const real = mkdtempSync(path.join(tmpdir(), 'restura-real-app-'));
  const linkParent = mkdtempSync(path.join(tmpdir(), 'restura-link-app-'));
  const link = path.join(linkParent, 'app');
  try {
    writeApp(real, {
      'package.json': JSON.stringify({ main: 'main.js' }),
      'main.js': "require('./feature.js');\n",
      'feature.js': "require('shipped');\n",
      'node_modules/shipped/package.json': JSON.stringify({ main: 'index.js' }),
      'node_modules/shipped/index.js': 'module.exports = {};\n',
    });
    symlinkSync(real, link);
    const result = findMissingRuntimeRequires(link);
    assert.deepEqual(specifiers(result), []);
    assert.deepEqual(result.checked, ['shipped']);
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
  }
});

test('a package whose entry file was not packed is missing', () => {
  const app = mkdtempSync(path.join(tmpdir(), 'restura-entry-missing-'));
  try {
    writeApp(app, {
      'package.json': JSON.stringify({ main: 'main.js' }),
      'main.js': "require('half-packed');\n",
      'node_modules/half-packed/package.json': JSON.stringify({ main: 'dist/index.js' }),
    });
    const result = findMissingRuntimeRequires(app);
    assert.deepEqual(specifiers(result), ['half-packed']);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('verifyPackagedMainRequires reads the same failure out of an asar', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'restura-asar-src-'));
  const src = path.join(root, 'app');
  const archive = path.join(root, 'app.asar');
  try {
    writeApp(src, {
      'package.json': JSON.stringify({ main: 'main.js' }),
      'main.js': "require('@modelcontextprotocol/node');\nrequire('node:fs');\n",
    });
    await asar.createPackage(src, archive);
    const result = verifyPackagedMainRequires(archive);
    assert.deepEqual(specifiers(result), ['@modelcontextprotocol/node']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
