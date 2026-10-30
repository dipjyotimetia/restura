import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectsEveryProject, describePlan, planFor } from '../type-check-related.mjs';

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
