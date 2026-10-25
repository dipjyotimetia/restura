import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyWorktree, isEffectivelyClean, parseWorktreeList } from '../worktree-prune.mjs';

test('parses porcelain worktree output, including detached and locked entries', () => {
  const out = [
    'worktree /repo',
    'HEAD 1111',
    'branch refs/heads/main',
    '',
    'worktree /repo/.claude/worktrees/agent-a',
    'HEAD 2222',
    'branch refs/heads/fix/x',
    '',
    'worktree /tmp/rb',
    'HEAD 3333',
    'detached',
    'locked agent running',
    '',
  ].join('\n');
  assert.deepEqual(parseWorktreeList(out), [
    { path: '/repo', head: '1111', branch: 'main', locked: false },
    { path: '/repo/.claude/worktrees/agent-a', head: '2222', branch: 'fix/x', locked: false },
    { path: '/tmp/rb', head: '3333', branch: null, locked: true },
  ]);
});

test('untracked node_modules links from worktree:setup do not make a worktree dirty', () => {
  assert.ok(isEffectivelyClean(''));
  assert.ok(
    isEffectivelyClean(
      '?? node_modules\n?? extension/vscode/node_modules\n?? docs-site/node_modules/\n'
    )
  );
  assert.ok(!isEffectivelyClean(' M src/a.ts\n?? node_modules\n'));
  assert.ok(!isEffectivelyClean('?? scratch.txt\n'));
});

const base = { path: '/repo/.claude/worktrees/a', branch: 'fix/x', locked: false };

test('main checkout, locked, dirty and unmerged worktrees are kept', () => {
  assert.equal(classifyWorktree({ ...base, isMain: true, clean: true, ahead: 0 }).action, 'keep');
  assert.equal(classifyWorktree({ ...base, locked: true, clean: true, ahead: 0 }).action, 'keep');
  assert.equal(classifyWorktree({ ...base, clean: false, ahead: 0 }).action, 'keep');
  const unmerged = classifyWorktree({ ...base, clean: true, ahead: 3, prState: 'OPEN' });
  assert.equal(unmerged.action, 'keep');
  assert.match(unmerged.reason, /OPEN/);
});

test('clean worktrees whose work is merged are pruned', () => {
  assert.equal(classifyWorktree({ ...base, clean: true, ahead: 0 }).action, 'prune');
  assert.equal(
    classifyWorktree({ ...base, clean: true, ahead: 4, prState: 'MERGED' }).action,
    'prune'
  );
  assert.equal(
    classifyWorktree({ ...base, clean: true, ahead: 2, patchMerged: true }).action,
    'prune'
  );
  assert.equal(
    classifyWorktree({ ...base, clean: true, ahead: 2, supersededBy: '#1093' }).action,
    'prune'
  );
});

test('a closed-unmerged PR is not proof the work landed', () => {
  assert.equal(
    classifyWorktree({ ...base, clean: true, ahead: 2, prState: 'CLOSED' }).action,
    'keep'
  );
});

test('young worktrees are kept even when they look merged (an agent may have just created them)', () => {
  const young = classifyWorktree({ ...base, clean: true, ahead: 0, ageHours: 2 });
  assert.equal(young.action, 'keep');
  assert.match(young.reason, /h old/);
  assert.equal(classifyWorktree({ ...base, clean: true, ahead: 0, ageHours: 48 }).action, 'prune');
});

test('the worktree the script runs from is never pruned', () => {
  assert.equal(
    classifyWorktree({ ...base, isCurrent: true, clean: true, ahead: 0 }).action,
    'keep'
  );
});

test('a MERGED PR only counts when the local head is contained in the merged PR head', () => {
  const reused = classifyWorktree({
    ...base,
    clean: true,
    ahead: 3,
    prState: 'MERGED',
    prContainsHead: false,
  });
  assert.equal(reused.action, 'keep');
  assert.match(reused.reason, /not in the merged PR/);
  assert.equal(
    classifyWorktree({ ...base, clean: true, ahead: 3, prState: 'MERGED', prContainsHead: true })
      .action,
    'prune'
  );
});
