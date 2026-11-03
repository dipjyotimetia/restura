import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  affectsEveryProject,
  changedSinceMergeBase,
  describePlan,
  planFor,
} from '../type-check-related.mjs';

test('renderer-only changes run just the renderer check', () => {
  const plan = planFor(['src/features/grpc/lib/x.ts', 'src/components/A.tsx', 'README.md']);
  assert.equal(plan.all, false);
  assert.deepEqual(plan.projects, ['renderer']);
  assert.deepEqual(plan.commands, [['npm', 'run', 'type-check']]);
});

test('each non-renderer root maps to its own project, renderer still first', () => {
  const plan = planFor([
    'electron/main/handlers/a.ts',
    'worker/handlers/b.ts',
    'cli/src/runner/c.ts',
    'echo/d.ts',
    'echo-local/e.ts',
    'src/features/http/f.ts',
    'extension/chrome/g.ts',
    'extension/vscode/h.ts',
    'scripts/i.mjs',
    '.claude/hooks/j.mjs',
    'vitest.config.ts',
  ]);
  assert.equal(plan.all, false);
  assert.deepEqual(plan.projects, [
    'renderer',
    'electron',
    'worker',
    'http-feature',
    'echo',
    'echo-local',
    'cli',
    'extension-chrome',
    'extension-vscode',
    'tooling',
  ]);
  assert.ok(
    plan.commands.some((c) => c.join(' ') === 'npx tsc --noEmit -p electron/tsconfig.json')
  );
  assert.ok(plan.commands.some((c) => c.join(' ') === 'npm run --workspace cli type-check'));
});

test('shared/, package.json and any tsconfig escalate to type-check:all', () => {
  for (const f of [
    'shared/protocol/x.ts',
    'package.json',
    'tsconfig.json',
    'electron/tsconfig.json',
  ]) {
    assert.ok(affectsEveryProject(f), f);
    const plan = planFor([f]);
    assert.equal(plan.all, true);
    assert.deepEqual(plan.commands, [['npm', 'run', 'type-check:all']]);
  }
});

test('e2e mocks and utils compile under echo-local; other e2e files are renderer-only', () => {
  assert.deepEqual(planFor(['e2e/mocks/a.ts']).projects, ['renderer', 'echo-local']);
  assert.deepEqual(planFor(['e2e/specs/a.spec.ts']).projects, ['renderer']);
});

test('non-typed files never add projects and Windows separators are normalised', () => {
  assert.deepEqual(planFor(['docs/x.md', 'electron\\main\\y.ts']).projects, [
    'renderer',
    'electron',
  ]);
  assert.match(describePlan(planFor(['shared/a.ts'])), /every project/);
  assert.match(describePlan(planFor(['cli/a.ts'])), /renderer, cli/);
});

test('changedSinceMergeBase includes deleted files and both sides of a rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tcr-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  try {
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'worker'));
    writeFileSync(join(dir, 'worker/gone.ts'), 'export const a = 1;\n'.repeat(20));
    writeFileSync(join(dir, 'worker/old.ts'), 'export const b = 2;\n'.repeat(20));
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('rm', '-q', 'worker/gone.ts');
    git('mv', 'worker/old.ts', 'worker/new.ts');
    git('commit', '-q', '-m', 'change');
    const files = changedSinceMergeBase(dir);
    assert.deepEqual(files?.sort(), ['worker/gone.ts', 'worker/new.ts', 'worker/old.ts']);
    assert.ok(planFor(files ?? []).projects.includes('worker'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
