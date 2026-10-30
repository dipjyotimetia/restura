#!/usr/bin/env node
// Type-check only the tsconfig projects a branch touched.
//
// `npm run type-check` covers the renderer alone (the root tsconfig excludes
// worker/, electron/main, cli/, ...), and `npm run type-check:all` runs all
// nine projects (about a minute). The pre-push hook used to run the renderer
// check only, so a worker/Electron/CLI type error passed locally and failed in
// CI. This script maps changed paths to the projects that compile them and
// runs exactly those (the renderer always, as before). `shared/` and the
// root config files are compiled by every project, so a change there runs
// `type-check:all`.
//
//   node scripts/type-check-related.mjs            # changed vs merge-base with origin/main
//   node scripts/type-check-related.mjs --print    # show the plan, run nothing
//   node scripts/type-check-related.mjs --files a.ts b.ts   # explicit list (tests)
//
// No merge-base (fresh clone without origin/main): runs type-check:all.

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RENDERER = ['npm', 'run', 'type-check'];
const ALL = ['npm', 'run', 'type-check:all'];

/**
 * Project matchers, in the order their commands run. `match` gets a
 * forward-slashed repo-relative path.
 */
export const PROJECTS = [
  {
    name: 'electron',
    match: (f) => f.startsWith('electron/'),
    command: ['npx', 'tsc', '--noEmit', '-p', 'electron/tsconfig.json'],
  },
  {
    name: 'worker',
    match: (f) => f.startsWith('worker/'),
    command: ['npx', 'tsc', '--noEmit', '-p', 'worker/tsconfig.json'],
  },
  {
    name: 'http-feature',
    match: (f) => f.startsWith('src/features/http/') || f.startsWith('src/types/'),
    command: ['npx', 'tsc', '--noEmit', '-p', 'src/features/http/tsconfig.json'],
  },
  {
    name: 'echo',
    match: (f) => f.startsWith('echo/'),
    command: ['npx', 'tsc', '--noEmit', '-p', 'echo/tsconfig.json'],
  },
  {
    name: 'echo-local',
    match: (f) =>
      f.startsWith('echo-local/') || f.startsWith('e2e/mocks/') || f.startsWith('e2e/utils/'),
    command: ['npx', 'tsc', '--noEmit', '-p', 'echo-local/tsconfig.json'],
  },
  {
    name: 'cli',
    match: (f) => f.startsWith('cli/'),
    command: ['npm', 'run', '--workspace', 'cli', 'type-check'],
  },
  {
    name: 'extension-chrome',
    match: (f) => f.startsWith('extension/chrome/'),
    command: ['npm', 'run', '--workspace', '@restura/extension', 'type-check'],
  },
  {
    name: 'extension-vscode',
    match: (f) => f.startsWith('extension/vscode/'),
    command: ['npm', 'run', '--workspace', 'restura-vscode', 'type-check'],
  },
  {
    name: 'tooling',
    match: (f) =>
      f.startsWith('scripts/') ||
      f.startsWith('.claude/hooks/') ||
      /^[^/]+\.config\.(ts|mts|mjs)$/.test(f),
    command: ['npm', 'run', 'type-check:tooling'],
  },
];

/** Paths every project compiles or that change how every project compiles. */
export function affectsEveryProject(f) {
  return (
    f.startsWith('shared/') ||
    f === 'package.json' ||
    f === 'package-lock.json' ||
    /^tsconfig[^/]*\.json$/.test(f) ||
    /(^|\/)tsconfig[^/]*\.json$/.test(f)
  );
}

const isTyped = (f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|d\.ts)$/.test(f);

/**
 * Pure: the plan for a set of changed paths.
 * @param {string[]} files
 * @returns {{ all: boolean; projects: string[]; commands: string[][] }}
 */
export function planFor(files) {
  const typed = files.map((f) => f.replace(/\\/g, '/')).filter(isTyped);
  if (typed.some(affectsEveryProject)) return { all: true, projects: ['all'], commands: [ALL] };
  const hit = PROJECTS.filter((p) => typed.some(p.match));
  return {
    all: false,
    projects: ['renderer', ...hit.map((p) => p.name)],
    commands: [RENDERER, ...hit.map((p) => p.command)],
  };
}

/** Files changed between the merge-base with origin/main and HEAD; null when there is no merge-base. */
export function changedSinceMergeBase(cwd = process.cwd()) {
  let base;
  try {
    base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
  if (!base) return null;
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=d', base, 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

export function describePlan(plan) {
  const what = plan.all
    ? 'every project (shared/ or root config changed)'
    : plan.projects.join(', ');
  return `type-check:related → ${what}`;
}

function main(argv) {
  const print = argv.includes('--print');
  const filesIdx = argv.indexOf('--files');
  let files;
  if (filesIdx !== -1) files = argv.slice(filesIdx + 1);
  else {
    files = changedSinceMergeBase();
    if (files === null) {
      console.log(
        'type-check:related → no merge-base with origin/main (run git fetch); checking every project.'
      );
      files = ['shared/__no-merge-base__.ts'];
    }
  }
  const plan = planFor(files);
  console.log(describePlan(plan));
  if (print) return 0;
  for (const command of plan.commands) {
    const [cmd, ...args] = command;
    const run = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (run.status !== 0) return run.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
