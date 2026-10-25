#!/usr/bin/env node
// List linked git worktrees and prune the ones whose work has landed.
//
// Agent-driven delivery leaves worktrees behind (`.claude/worktrees/agent-*`
// from isolation: worktree, plus ad-hoc ones under /tmp). Left alone they pile
// up (73 on 2026-10-25, each with its own node_modules links). This prunes ONLY
// worktrees that are clean AND merged; everything else is listed with the
// reason it was kept, for a human to decide.
//
//   clean  = no changes except the untracked node_modules links worktree:setup makes
//   merged = nothing ahead of the base, OR its PR is MERGED (squash merges are
//            not ancestors, so the PR state is the signal), OR every commit is
//            patch-equivalent on the base (`git cherry`)
//
// Usage: npm run worktree:prune [-- --apply] [--branches] [--base origin/main] [--no-gh]
// Default is a dry run. --branches also deletes the local branch of a pruned worktree.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseWorktreeList(porcelain) {
  const list = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: '', branch: null, locked: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
  }
  return list;
}

export function isEffectivelyClean(statusPorcelain) {
  return statusPorcelain
    .split('\n')
    .filter(Boolean)
    .every((l) => /^\?\? (?:.*\/)?node_modules\/?$/.test(l));
}

/** @returns {{action: 'keep'|'prune', reason: string}} */
export function classifyWorktree(wt) {
  if (wt.isMain) return { action: 'keep', reason: 'main checkout' };
  if (wt.locked) return { action: 'keep', reason: 'locked (an agent may be running in it)' };
  if (!wt.clean) return { action: 'keep', reason: 'uncommitted changes' };
  if (wt.ahead === 0) return { action: 'prune', reason: 'nothing ahead of base' };
  if (wt.prState === 'MERGED') return { action: 'prune', reason: 'PR merged' };
  if (wt.patchMerged) return { action: 'prune', reason: 'all commits patch-equivalent on base' };
  if (wt.supersededBy) return { action: 'prune', reason: `superseded by ${wt.supersededBy}` };
  return {
    action: 'keep',
    reason: `${wt.ahead} commit(s) not on base${wt.prState ? `, PR ${wt.prState}` : ', no PR'}`,
  };
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryRun = (cmd, args, cwd) => {
  try {
    return run(cmd, args, cwd);
  } catch {
    return null;
  }
};

export function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const branches = argv.includes('--branches');
  const useGh = !argv.includes('--no-gh');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'origin/main';
  const repo = run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    process.cwd()
  ).replace(/\/\.git$/, '');
  tryRun('git', ['fetch', '--quiet', 'origin'], repo);

  const prs = new Map();
  if (useGh) {
    const json = tryRun(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'headRefName,state,number'],
      repo
    );
    for (const pr of json ? JSON.parse(json) : []) {
      // Prefer MERGED over OPEN/CLOSED when a branch name was reused.
      if (prs.get(pr.headRefName)?.state !== 'MERGED') prs.set(pr.headRefName, pr);
    }
  }

  const rows = [];
  for (const wt of parseWorktreeList(run('git', ['worktree', 'list', '--porcelain'], repo))) {
    const isMain = wt.path === repo;
    const status = isMain ? '' : tryRun('git', ['status', '--porcelain'], wt.path);
    const ahead = Number(tryRun('git', ['rev-list', '--count', `${base}..${wt.head}`], repo) ?? 1);
    const cherry = ahead > 0 ? (tryRun('git', ['cherry', base, wt.head], repo) ?? '+') : '';
    const pr = wt.branch ? prs.get(wt.branch) : undefined;
    const info = {
      ...wt,
      isMain,
      clean: status !== null && isEffectivelyClean(status),
      ahead,
      prState: pr?.state,
      patchMerged:
        ahead > 0 &&
        cherry
          .split('\n')
          .filter(Boolean)
          .every((l) => l.startsWith('-')),
    };
    rows.push({ ...info, ...classifyWorktree(info), pr: pr ? `#${pr.number}` : '' });
  }

  for (const r of rows) {
    console.log(
      `${r.action === 'prune' ? (apply ? 'PRUNED ' : 'PRUNE  ') : 'keep   '} ${r.path}  [${r.branch ?? 'detached'}${r.pr ? ` ${r.pr}` : ''}] ${r.reason}`
    );
    if (apply && r.action === 'prune') {
      tryRun('git', ['worktree', 'remove', '--force', r.path], repo);
      if (branches && r.branch) tryRun('git', ['branch', '-D', r.branch], repo);
    }
  }
  if (apply) tryRun('git', ['worktree', 'prune'], repo);
  const n = rows.filter((r) => r.action === 'prune').length;
  console.log(
    `\n${n} prunable, ${rows.length - n} kept${apply ? '' : ' (dry run — pass --apply to remove)'}`
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
