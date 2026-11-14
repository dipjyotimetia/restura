// The packaged Electron app crashed on launch (#1353) because the main
// process `require()`d `@modelcontextprotocol/node` and electron-builder had
// not copied that package into app.asar (it was a devDependency). Resolving
// against the workspace node_modules cannot catch this: devDependencies are
// installed there. This walks the packaged main and preload require graphs
// and resolves each bare specifier from inside an extracted copy of the asar.
// A hit outside that tree — the workspace install, via Node's parent
// node_modules walk — counts as not shipped.
//
// Usage: node scripts/verify-packaged-main-requires.mjs <path-to-app.asar>

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import asar from '@electron/asar';

const PRELOAD_REL = path.join('dist', 'electron', 'electron', 'main', 'preload.js');

/** Drop block comments so a doc comment that mentions require('…') is not a dependency. */
export function stripBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function literalSpecifiers(source) {
  const specs = [];
  const re = /(?:require|import)\(\s*(['"])([^'"\\]+)\1\s*\)/g;
  for (const match of stripBlockComments(source).matchAll(re)) {
    specs.push(match[2]);
  }
  return specs;
}

/** electron is provided by the runtime, not by app.asar/node_modules. */
export function isElectronSpecifier(specifier) {
  return specifier === 'electron' || specifier.startsWith('electron/');
}

/**
 * True when `resolved` is a file inside `appDir`. Builtin ids (`fs`,
 * `node:fs`) are not absolute and count as resolved. A path outside `appDir`
 * is the workspace (or another parent) install, which the packaged app does
 * not contain.
 */
export function isShippedResolution(appDir, resolved) {
  if (!path.isAbsolute(resolved)) return true;
  const rel = path.relative(path.resolve(appDir), resolved);
  if (rel === '' || path.isAbsolute(rel)) return false;
  return !rel.startsWith('..');
}

function readSource(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function tryResolve(fromFile, specifier) {
  return createRequire(fromFile).resolve(specifier);
}

/** require.resolve realpaths. os.tmpdir() on macOS does not (`/var` → `/private/var`). */
function canonical(file) {
  const resolved = path.resolve(file);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function shouldParse(file) {
  return file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.mjs');
}

function insideNodeModules(appDir, file) {
  const rel = path.relative(path.resolve(appDir), file);
  return rel.split(path.sep).includes('node_modules');
}

/**
 * @param {string} appDir extracted (or fixture) app root
 * @returns {{ missing: Array<{ specifier: string, from: string, message: string }>, checked: string[] }}
 */
export function findMissingRuntimeRequires(appDir) {
  const root = canonical(appDir);
  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    return {
      missing: [
        {
          specifier: 'package.json',
          from: root,
          message: 'packaged app has no package.json',
        },
      ],
      checked: [],
    };
  }

  let mainRel = '';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof pkg.main === 'string') mainRel = pkg.main;
  } catch (err) {
    return {
      missing: [
        {
          specifier: 'package.json',
          from: pkgPath,
          message: err instanceof Error ? err.message : String(err),
        },
      ],
      checked: [],
    };
  }

  const entries = [];
  if (mainRel) {
    const mainFile = path.resolve(root, mainRel);
    if (!existsSync(mainFile)) {
      return {
        missing: [
          {
            specifier: mainRel,
            from: pkgPath,
            message: 'package.json main does not exist in the packaged app',
          },
        ],
        checked: [],
      };
    }
    entries.push(mainFile);
  }
  const preload = path.join(root, PRELOAD_REL);
  if (existsSync(preload)) entries.push(preload);
  if (entries.length === 0) {
    return {
      missing: [
        {
          specifier: '(entry)',
          from: root,
          message: 'packaged app has no main or preload entry',
        },
      ],
      checked: [],
    };
  }

  const seenFiles = new Set();
  const seenSpecs = new Set();
  const missing = [];
  const checked = [];
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seenFiles.has(file)) continue;
    seenFiles.add(file);
    if (!shouldParse(file) || insideNodeModules(root, file)) continue;
    const source = readSource(file);
    if (source == null) continue;

    for (const specifier of literalSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        let resolved;
        try {
          resolved = tryResolve(file, specifier);
        } catch (err) {
          missing.push({
            specifier,
            from: path.relative(root, file),
            message: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (path.isAbsolute(resolved)) resolved = canonical(resolved);
        if (
          isShippedResolution(root, resolved) &&
          !insideNodeModules(root, resolved) &&
          shouldParse(resolved)
        ) {
          queue.push(resolved);
        }
        continue;
      }

      if (isElectronSpecifier(specifier) || seenSpecs.has(specifier)) continue;
      seenSpecs.add(specifier);
      let resolved;
      try {
        resolved = tryResolve(file, specifier);
      } catch (err) {
        missing.push({
          specifier,
          from: path.relative(root, file),
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // `node:fs` resolves to a builtin id, not a file in the archive.
      if (!path.isAbsolute(resolved)) continue;
      resolved = canonical(resolved);
      if (!isShippedResolution(root, resolved)) {
        missing.push({
          specifier,
          from: path.relative(root, file),
          message: `resolved outside the packaged app (${resolved})`,
        });
        continue;
      }
      checked.push(specifier);
    }
  }

  missing.sort((a, b) => a.specifier.localeCompare(b.specifier) || a.from.localeCompare(b.from));
  checked.sort();
  return { missing, checked };
}

/**
 * Extract `asarPath` and return runtime requires that do not resolve inside it.
 * The extract lives under the OS temp dir so Node's parent walk cannot satisfy
 * a require from this repository's node_modules.
 */
export function verifyPackagedMainRequires(asarPath) {
  const dir = mkdtempSync(path.join(tmpdir(), 'restura-main-requires-'));
  try {
    asar.extractAll(asarPath, dir);
    return findMissingRuntimeRequires(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  const asarPath = process.argv[2];
  if (!asarPath) {
    console.error('::error::usage: verify-packaged-main-requires.mjs <app.asar>');
    process.exit(1);
  }
  const { missing, checked } = verifyPackagedMainRequires(path.resolve(asarPath));
  if (missing.length > 0) {
    console.error(
      '::error::Packaged main process requires modules that are not shipped in app.asar:'
    );
    for (const item of missing) {
      console.error(`- ${item.specifier} (from ${item.from}): ${item.message}`);
    }
    process.exit(1);
  }
  console.log(
    `OK: packaged main process resolves ${checked.length} runtime requires inside app.asar`
  );
}
