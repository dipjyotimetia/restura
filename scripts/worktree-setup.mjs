#!/usr/bin/env node
// Prepare a linked git worktree to run Restura's gates without a fresh install:
// symlink every node_modules the main checkout has (root + npm workspaces +
// docs-site) and copy `.dev.vars`. Idempotent; refuses to run in the main
// checkout. Every link is verified to be gitignored so it cannot be committed
// (scripts/guard-staged.mjs is the second line of defence).
//
// Hooks: husky stores core.hooksPath in the SHARED repo config. When that is
// an absolute path into the main checkout, every worktree runs the main
// checkout's .husky/* scripts (whatever branch it has checked out), not its
// own. `--hooks` gives this worktree its own hooks: it copies the husky
// runner into <worktree>/.husky/_ and sets a per-worktree core.hooksPath
// (enabling extensions.worktreeConfig, a local-only repo setting).
//
// Usage: npm run worktree:setup [-- <worktreePath>] [--hooks]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude', '.worktrees']);

/**
 * Directories (relative, '.' for the root) whose node_modules should be linked.
 * Pure: the caller supplies filesystem probes.
 * @param {{ workspaces: string[]; candidates: string[]; mainHasNodeModules: (dir: string) => boolean; worktreeHasPackage: (dir: string) => boolean }} input
 */
export function planLinks({ workspaces, candidates, mainHasNodeModules, worktreeHasPackage }) {
  const dirs = [...new Set(['.', ...workspaces, ...candidates])].map((dir) =>
    dir === '.' ? '.' : path.posix.normalize(dir).replace(/\/$/, '')
  );
  return [...new Set(dirs)]
    .filter((dir) => mainHasNodeModules(dir) && (dir === '.' || worktreeHasPackage(dir)))
    .sort();
}

/**
 * Where hooks for this worktree come from.
 * @param {{ hooksPath: string | undefined; worktree: string }} input
 * @returns {'own' | 'foreign' | 'default'}
 */
export function hooksSource({ hooksPath, worktree }) {
  if (!hooksPath) return 'default';
  if (!path.isAbsolute(hooksPath)) return 'own';
  const relative = path.relative(worktree, hooksPath);
  return relative.startsWith('..') || path.isAbsolute(relative) ? 'foreign' : 'own';
}

/**
 * What to do with one link location.
 * @param {{ kind: 'missing' | 'symlink' | 'other'; currentTarget?: string; target: string }} state
 * @returns {'create' | 'ok' | 'skip-real' | 'skip-foreign'}
 */
export function linkAction({ kind, currentTarget, target }) {
  if (kind === 'missing') return 'create';
  if (kind === 'symlink')
    return path.resolve(currentTarget ?? '') === path.resolve(target) ? 'ok' : 'skip-foreign';
  return 'skip-real';
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Depth-1 and depth-2 directories that hold a package.json. */
function packageDirs(root) {
  const found = [];
  const walk = (relative, depth) => {
    if (depth > 2) return;
    for (const dirent of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!dirent.isDirectory() || SKIP_DIRS.has(dirent.name) || dirent.name.startsWith('.'))
        continue;
      const child = relative === '.' ? dirent.name : `${relative}/${dirent.name}`;
      if (fs.existsSync(path.join(root, child, 'package.json'))) found.push(child);
      walk(child, depth + 1);
    }
  };
  walk('.', 1);
  return found;
}

export function setupWorktree(
  worktreeArg = process.cwd(),
  log = console.log,
  { hooks = false } = {}
) {
  const worktree = git(['rev-parse', '--show-toplevel'], path.resolve(worktreeArg));
  const gitDir = path.resolve(worktree, git(['rev-parse', '--git-dir'], worktree));
  const commonDir = path.resolve(worktree, git(['rev-parse', '--git-common-dir'], worktree));
  if (gitDir === commonDir) {
    throw new Error(
      `${worktree} is the main checkout; run this from a linked worktree (git worktree add).`
    );
  }
  const main = path.dirname(commonDir);
  const pkg = JSON.parse(fs.readFileSync(path.join(main, 'package.json'), 'utf8'));
  const dirs = planLinks({
    workspaces: Array.isArray(pkg.workspaces) ? pkg.workspaces : [],
    candidates: packageDirs(main),
    mainHasNodeModules: (dir) => fs.existsSync(path.join(main, dir, 'node_modules')),
    worktreeHasPackage: (dir) => fs.existsSync(path.join(worktree, dir, 'package.json')),
  });

  const rows = [];
  for (const dir of dirs) {
    const link = path.join(worktree, dir, 'node_modules');
    const target = path.join(main, dir, 'node_modules');
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    const action = linkAction({
      kind: !stat ? 'missing' : stat.isSymbolicLink() ? 'symlink' : 'other',
      currentTarget: stat?.isSymbolicLink()
        ? path.resolve(path.dirname(link), fs.readlinkSync(link))
        : undefined,
      target,
    });
    if (action === 'create') fs.symlinkSync(target, link, 'dir');
    rows.push([path.posix.join(dir, 'node_modules'), action === 'create' ? 'linked' : action]);
  }

  const devVars = path.join(main, '.dev.vars');
  const devVarsTarget = path.join(worktree, '.dev.vars');
  if (fs.existsSync(devVars)) {
    if (fs.existsSync(devVarsTarget)) rows.push(['.dev.vars', 'ok (exists)']);
    else {
      fs.copyFileSync(devVars, devVarsTarget);
      rows.push(['.dev.vars', 'copied']);
    }
  }

  const readHooksPath = () => {
    try {
      return git(['config', '--get', 'core.hooksPath'], worktree);
    } catch {
      return undefined;
    }
  };
  let hooksPath = readHooksPath();
  if (hooks && hooksSource({ hooksPath, worktree }) === 'foreign') {
    const runner = path.join(main, '.husky', '_');
    if (!fs.existsSync(runner)) {
      throw new Error(`No husky runner at ${runner}; run npm install in the main checkout.`);
    }
    fs.cpSync(runner, path.join(worktree, '.husky', '_'), { recursive: true });
    git(['config', 'extensions.worktreeConfig', 'true'], worktree);
    git(['config', '--worktree', 'core.hooksPath', '.husky/_'], worktree);
    hooksPath = readHooksPath();
  }
  const source = hooksSource({ hooksPath, worktree });
  const hooksRow = [
    'git hooks',
    source === 'foreign'
      ? `FROM ${hooksPath} (another checkout's .husky; re-run with --hooks)`
      : `ok (${hooksPath ?? '.git/hooks'})`,
  ];

  const unignored = rows
    .map(([relative]) => relative)
    .filter((relative) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', relative], { cwd: worktree });
        return false;
      } catch {
        return true;
      }
    });

  log(`worktree:setup ${worktree}\n  main checkout: ${main}`);
  for (const [relative, status] of [...rows, hooksRow]) log(`  ${relative.padEnd(36)} ${status}`);
  if (unignored.length > 0) {
    throw new Error(
      `Not gitignored (would be committable): ${unignored.join(', ')}. Fix .gitignore first.`
    );
  }
  log('  all links are gitignored.');
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = process.argv.slice(2);
    const target = args.find((arg) => !arg.startsWith('--'));
    setupWorktree(target, console.log, { hooks: args.includes('--hooks') });
  } catch (error) {
    console.error(`worktree:setup: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
