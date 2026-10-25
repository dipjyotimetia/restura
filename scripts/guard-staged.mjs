#!/usr/bin/env node
// Pre-commit guard: reject staged entries that only make sense on the author's
// machine. Run from .husky/pre-commit before lint-staged.
//
// Each rule exists because the mistake already shipped once:
//   - symlinks: a worktree's absolute `node_modules` symlink was committed
//     (#1156). Tracked relative skill links under `.claude/skills/` are allowed.
//   - any `node_modules` path segment, `.dev.vars` (local Worker secrets).
//   - `*.snap`: the repo gitignores `*.snap` (Linux snap packages), so a
//     snapshot file passes locally and is missing in CI. Use
//     toMatchInlineSnapshot instead.
//   - leaked local paths: an added line containing this checkout's absolute
//     path, or `/Users/<name>/.../<repo>` / `/home/<name>/.../<repo>`. Only
//     ADDED lines of text files under 1 MB are checked, so pre-existing
//     occurrences never block an unrelated edit.
//
// Deliberate exceptions: `git commit --no-verify`.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_SCANNED_BYTES = 1024 * 1024;

/** Symlinks the repo tracks on purpose: relative links into `.agents/skills`. */
export const ALLOWED_SYMLINK_PREFIXES = ['.claude/skills/'];

/**
 * @typedef {object} StagedEntry
 * @property {string} path
 * @property {string} mode  git file mode, e.g. 100644 or 120000
 * @property {string} [symlinkTarget]
 * @property {string[]} [addedLines]  added lines (text files under the size cap)
 */

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the leaked-local-path matcher for this checkout.
 * @param {{ repoRoots: string[]; repoName: string }} context
 */
export function localPathPattern({ repoRoots, repoName }) {
  const roots = repoRoots.filter((root) => root.length > 1).map(escapeRegExp);
  const name = escapeRegExp(repoName);
  const home = String.raw`/(?:Users|home)/[^/\s'"\`]+/(?:[^\s'"\`]*/)?${name}(?=[/\s'"\`]|$)`;
  return new RegExp([...roots, home].join('|'));
}

/**
 * Pure decision function: one message per rejected entry.
 * @param {StagedEntry[]} entries
 * @param {{ repoRoots: string[]; repoName: string }} context
 * @returns {string[]}
 */
export function findStagedViolations(entries, context) {
  const leaked = localPathPattern(context);
  const problems = [];

  for (const entry of entries) {
    const segments = entry.path.split('/');
    const base = segments[segments.length - 1] ?? '';

    if (segments.includes('node_modules')) {
      problems.push(
        `${entry.path}: node_modules must never be committed (worktree symlink or install leak).`
      );
      continue;
    }
    if (base === '.dev.vars') {
      problems.push(`${entry.path}: .dev.vars holds local Worker secrets; it must stay untracked.`);
      continue;
    }
    if (entry.mode === '120000') {
      const target = entry.symlinkTarget ?? '';
      const allowed = ALLOWED_SYMLINK_PREFIXES.some((prefix) => entry.path.startsWith(prefix));
      if (!allowed || path.posix.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) {
        problems.push(
          `${entry.path}: new symlink -> ${target || '?'} (symlinks are only allowed as relative links under ${ALLOWED_SYMLINK_PREFIXES.join(', ')}).`
        );
      }
      continue;
    }
    if (base.endsWith('.snap')) {
      problems.push(
        `${entry.path}: *.snap is gitignored, so this snapshot would be missing in CI. Use toMatchInlineSnapshot() instead.`
      );
      continue;
    }
    const line = (entry.addedLines ?? []).find((added) => leaked.test(added));
    if (line !== undefined) {
      problems.push(
        `${entry.path}: adds a machine-local absolute path (${line.trim().slice(0, 120)}). Use a repo-relative path.`
      );
    }
  }
  return problems;
}

/** Parse `git diff --cached --raw -z` output into {path, mode, sha}. */
export function parseRawDiff(raw) {
  const fields = raw.split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index];
    if (!header?.startsWith(':')) continue;
    const [, newMode, , newSha, status] = header.slice(1).split(' ');
    // Renames/copies carry two paths; the destination is the second.
    const twoPaths = status?.startsWith('R') || status?.startsWith('C');
    const file = fields[index + (twoPaths ? 2 : 1)];
    index += twoPaths ? 2 : 1;
    if (!file || status === 'D') continue;
    entries.push({ path: file, mode: newMode ?? '', sha: newSha ?? '' });
  }
  return entries;
}

/** Parse `git diff --cached -U0` output into added lines per path. */
export function parseAddedLines(patch) {
  const added = new Map();
  let current;
  let previous = '';
  for (const line of patch.split('\n')) {
    const isHeader = line.startsWith('+++ ') && previous.startsWith('--- ');
    previous = line;
    if (isHeader) {
      current =
        line === '+++ /dev/null'
          ? undefined
          : line.slice(4).replace(/\t.*$/, '').replace(/^b\//, '');
      if (current && !added.has(current)) added.set(current, []);
    } else if (current && line.startsWith('+')) {
      added.get(current)?.push(line.slice(1));
    }
  }
  return added;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function collectEntries(cwd) {
  const staged = parseRawDiff(
    git(
      ['diff', '--cached', '--raw', '--no-abbrev', '-z', '--no-renames', '--diff-filter=ACMRT'],
      cwd
    )
  );
  if (staged.length === 0) return [];

  const symlinks = staged.filter((entry) => entry.mode === '120000');
  const regular = staged.filter((entry) => entry.mode !== '120000' && entry.mode !== '160000');

  // Size-gate before diffing: one batched cat-file call for every blob.
  const sizes = new Map();
  if (regular.length > 0) {
    const out = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objectsize)'], {
      cwd,
      encoding: 'utf8',
      input: `${regular.map((entry) => entry.sha).join('\n')}\n`,
    });
    for (const line of out.trim().split('\n')) {
      const [sha, size] = line.split(' ');
      if (sha) sizes.set(sha, Number(size));
    }
  }
  const scanned = regular.filter(
    (entry) => (sizes.get(entry.sha) ?? Infinity) <= MAX_SCANNED_BYTES
  );
  const added =
    scanned.length > 0
      ? parseAddedLines(
          git(
            [
              // Unquoted paths so the +++ header keys match raw-diff paths.
              '-c',
              'core.quotePath=false',
              'diff',
              '--cached',
              '-U0',
              '--no-color',
              '--no-ext-diff',
              '--no-renames',
              '--',
              ...scanned.map((e) => `:(literal)${e.path}`),
            ],
            cwd
          )
        )
      : new Map();

  return staged.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    symlinkTarget: symlinks.includes(entry) ? git(['cat-file', 'blob', entry.sha], cwd) : undefined,
    addedLines: added.get(entry.path),
  }));
}

function main() {
  const cwd = process.cwd();
  const top = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const commonDir = path.resolve(top, git(['rev-parse', '--git-common-dir'], cwd).trim());
  const mainRoot = path.dirname(commonDir);
  const problems = findStagedViolations(collectEntries(top), {
    repoRoots: [...new Set([top, mainRoot])],
    repoName: path.basename(mainRoot),
  });
  if (problems.length === 0) return;
  console.error('guard-staged: refusing to commit these staged entries:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nUnstage them with `git restore --staged <path>`. Intentional? `git commit --no-verify`.'
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
