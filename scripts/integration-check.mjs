#!/usr/bin/env node
// Test several branches TOGETHER before merging any of them.
//
// PRs that are green alone can break main together (each PR's CI ran against
// a stale base and never saw the others). This merges the branches, in order,
// onto a fresh base in a throwaway worktree and runs the gates on the combined
// result. It never pushes and never modifies the given branches: merges are
// detached commits inside the temporary worktree.
//
// Usage:
//   npm run integration-check -- <branch...> [--base origin/main] [--e2e]
//     [--keep] [--continue-on-conflict] [--no-fetch] [--gates a,b]

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupWorktree } from './worktree-setup.mjs';

export const DEFAULT_GATES = [
  'type-check:all',
  'lint',
  'architecture:check',
  'capabilities:check',
  'verify:opencollection-types',
  'test:coverage',
];
export const E2E_GATES = [['test:e2e:electron:build', 'test:e2e:electron'], 'test:e2e'];

/** Regenerated outputs: overlap here is resolved by re-running codegen, not by hand. */
export const GENERATED_PATTERNS = [
  /^package-lock\.json$/,
  /(?:^|\/)package-lock\.json$/,
  /^docs\/CAPABILITY_MATRIX\.md$/,
  /^shared\/opencollection\/spec-types\.ts$/,
  /\.generated\.[cm]?[jt]sx?$/,
  /(?:^|\/)gen\//,
  /^openwiki\//,
];

/** Shared registries every feature PR tends to touch: the usual conflict hot-spots. */
export const REGISTRY_FILES = [
  'scripts/architecture.config.mts',
  'src/lib/shared/capabilities.ts',
  'vitest.config.ts',
  'package.json',
  'electron/shared/channels.ts',
  'electron/main/main.ts',
  'electron/main/preload.ts',
  'electron/main/ipc/ipc-validators.ts',
  'worker/app.ts',
  'src/lib/shared/database.ts',
  'src/lib/shared/store-validators.ts',
  'CHANGELOG.md',
];

export function parseIntegrationArgs(argv) {
  const options = {
    branches: [],
    base: 'origin/main',
    e2e: false,
    keep: false,
    continueOnConflict: false,
    fetch: true,
    gates: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--base needs a ref');
      options.base = value;
    } else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length);
    else if (arg === '--e2e') options.e2e = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--continue-on-conflict') options.continueOnConflict = true;
    else if (arg === '--no-fetch') options.fetch = false;
    else if (arg === '--gates') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--gates needs a comma list');
      options.gates = value.split(',').filter(Boolean);
    } else if (arg.startsWith('--gates='))
      options.gates = arg.slice('--gates='.length).split(',').filter(Boolean);
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else options.branches.push(arg);
  }
  if (options.branches.length === 0) throw new Error('Give at least one branch to integrate.');
  return options;
}

/**
 * Files changed (vs base) by more than one branch.
 * @param {Record<string, string[]>} changesByBranch
 * @returns {{ overlaps: Array<{ file: string; branches: string[] }>; generated: Array<{ file: string; branches: string[] }>; registries: Set<string> }}
 */
export function computeOverlap(changesByBranch) {
  const touchedBy = new Map();
  for (const [branch, files] of Object.entries(changesByBranch)) {
    for (const file of new Set(files)) {
      if (!touchedBy.has(file)) touchedBy.set(file, []);
      touchedBy.get(file).push(branch);
    }
  }
  const overlaps = [];
  const generated = [];
  for (const [file, branches] of [...touchedBy].sort(([a], [b]) => a.localeCompare(b))) {
    if (branches.length < 2) continue;
    (GENERATED_PATTERNS.some((pattern) => pattern.test(file)) ? generated : overlaps).push({
      file,
      branches,
    });
  }
  return {
    overlaps,
    generated,
    registries: new Set(overlaps.filter((o) => REGISTRY_FILES.includes(o.file)).map((o) => o.file)),
  };
}

/** Render rows as an aligned plain-text table. */
export function formatTable(header, rows) {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => String(row[column]).length))
  );
  const line = (row) =>
    row
      .map((cell, column) => String(cell).padEnd(widths[column]))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join(
    '\n'
  );
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function runGate(script, cwd, logFile) {
  // Appends, so a multi-step gate (build && run) shares one log.
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `$ npm run ${script}\n`);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, FORCE_COLOR: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const started = Date.now();
  const result = spawnSync('npm', ['run', script], {
    cwd,
    stdio: ['ignore', fd, fd],
    env,
    shell: process.platform === 'win32',
  });
  fs.closeSync(fd);
  return {
    ok: result.status === 0,
    // spawnSync blocks the event loop, so a process-level SIGINT listener never
    // runs; the terminal delivers Ctrl-C to the child and we see it here.
    interrupted: result.signal === 'SIGINT' || result.status === 130,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

export function integrate(options, log = console.log) {
  const repo = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (options.fetch) {
    log('Fetching origin…');
    git(['fetch', '--prune', 'origin'], repo);
  }
  const baseSha = git(['rev-parse', '--verify', `${options.base}^{commit}`], repo);
  const branchShas = options.branches.map((branch) => {
    const resolved = tryGit(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], repo);
    if (!resolved.ok) throw new Error(`Unknown branch/ref: ${branch}`);
    return resolved.output.trim();
  });

  const changes = Object.fromEntries(
    options.branches.map((branch, index) => [
      branch,
      git(['diff', '--name-only', `${baseSha}...${branchShas[index]}`], repo)
        .split('\n')
        .filter(Boolean),
    ])
  );
  const { overlaps, generated, registries } = computeOverlap(changes);
  log(`\nBase ${options.base} @ ${baseSha.slice(0, 10)}; branches: ${options.branches.join(', ')}`);
  log('\nFiles changed by more than one branch:');
  log(
    overlaps.length === 0
      ? '  (none)'
      : formatTable(
          ['file', 'branches', 'note'],
          overlaps.map((o) => [
            o.file,
            o.branches.join(', '),
            registries.has(o.file) ? 'REGISTRY' : '',
          ])
        )
  );
  if (generated.length > 0) {
    log('\nGenerated files touched by more than one branch (regenerate after merging):');
    log(
      formatTable(
        ['file', 'branches'],
        generated.map((o) => [o.file, o.branches.join(', ')])
      )
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `restura-integration-${stamp}-`));
  const worktree = path.join(tempRoot, 'worktree');
  const logDir = path.join(tempRoot, 'logs');
  fs.mkdirSync(logDir);
  const results = [];
  let failed = false;

  const cleanup = () => {
    if (options.keep) return;
    tryGit(['worktree', 'remove', '--force', worktree], repo);
    tryGit(['worktree', 'prune'], repo);
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);

  try {
    git(['worktree', 'add', '--detach', worktree, baseSha], repo);
    const identity = [
      '-c',
      'user.name=restura-integration-check',
      '-c',
      'user.email=integration-check@localhost',
    ];
    for (const [index, branch] of options.branches.entries()) {
      const merge = tryGit(
        [
          ...identity,
          'merge',
          '--no-ff',
          '--no-edit',
          '--no-verify',
          '-m',
          `integration-check: merge ${branch}`,
          branchShas[index],
        ],
        worktree
      );
      if (merge.ok) {
        results.push([`merge ${branch}`, 'PASS', '']);
        continue;
      }
      failed = true;
      const conflicted = tryGit(['diff', '--name-only', '--diff-filter=U'], worktree)
        .output.trim()
        .split('\n')
        .filter(Boolean);
      const logFile = path.join(logDir, `merge-${index + 1}.log`);
      fs.writeFileSync(logFile, `${merge.output}\nConflicted files:\n${conflicted.join('\n')}\n`);
      results.push([`merge ${branch}`, 'CONFLICT', logFile]);
      log(`\nConflict merging ${branch}:\n  ${conflicted.join('\n  ') || merge.output.trim()}`);
      tryGit(['merge', '--abort'], worktree);
      if (!options.continueOnConflict) break;
    }

    if (!failed || options.continueOnConflict) {
      setupWorktree(worktree, () => {});
      const gates = options.gates ?? [...DEFAULT_GATES, ...(options.e2e ? E2E_GATES : [])];
      for (const gate of gates) {
        const steps = Array.isArray(gate) ? gate : [gate];
        const name = steps.join(' && ');
        const logFile = path.join(logDir, `${steps.at(-1).replace(/[^\w.-]+/g, '_')}.log`);
        log(`Running ${name}…`);
        let outcome = { ok: true, seconds: 0 };
        let interrupted = false;
        for (const step of steps) {
          const stepOutcome = runGate(step, worktree, logFile);
          outcome = { ok: stepOutcome.ok, seconds: outcome.seconds + stepOutcome.seconds };
          interrupted = stepOutcome.interrupted;
          if (!stepOutcome.ok) break;
        }
        if (!outcome.ok) failed = true;
        results.push([
          name,
          outcome.ok ? `PASS (${outcome.seconds}s)` : `FAIL (${outcome.seconds}s)`,
          logFile,
        ]);
        if (interrupted) {
          log('Interrupted; skipping remaining gates.');
          break;
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    cleanup();
  }

  log(`\n${formatTable(['step', 'result', 'log'], results)}`);
  log(
    `\nLogs: ${logDir}${options.keep ? `\nWorktree kept: ${worktree} (remove with: git worktree remove --force ${worktree})` : ''}`
  );
  return { failed, results, overlaps, generated };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { failed } = integrate(parseIntegrationArgs(process.argv.slice(2)));
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error(`integration-check: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
