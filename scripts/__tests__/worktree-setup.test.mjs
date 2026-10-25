import assert from 'node:assert/strict';
import test from 'node:test';
import { hooksSource, linkAction, planLinks } from '../worktree-setup.mjs';

test('links root and every workspace/package dir the main checkout has installed', () => {
  const installed = new Set(['.', 'cli', 'docs-site', 'extension/vscode']);
  const dirs = planLinks({
    workspaces: ['cli', 'extension/chrome', 'extension/vscode/'],
    candidates: ['docs-site', 'e2e/mocks'],
    mainHasNodeModules: (dir) => installed.has(dir),
    worktreeHasPackage: () => true,
  });
  assert.deepEqual(dirs, ['.', 'cli', 'docs-site', 'extension/vscode']);
});

test('skips packages that do not exist in the worktree', () => {
  const dirs = planLinks({
    workspaces: ['cli'],
    candidates: [],
    mainHasNodeModules: () => true,
    worktreeHasPackage: (dir) => dir !== 'cli',
  });
  assert.deepEqual(dirs, ['.']);
});

test('is idempotent and never clobbers a real install or a foreign link', () => {
  assert.equal(linkAction({ kind: 'missing', target: '/m/node_modules' }), 'create');
  assert.equal(
    linkAction({ kind: 'symlink', currentTarget: '/m/node_modules/', target: '/m/node_modules' }),
    'ok'
  );
  assert.equal(
    linkAction({
      kind: 'symlink',
      currentTarget: '/other/node_modules',
      target: '/m/node_modules',
    }),
    'skip-foreign'
  );
  assert.equal(linkAction({ kind: 'other', target: '/m/node_modules' }), 'skip-real');
});

test('detects hooks borrowed from another checkout', () => {
  const worktree = '/repo/.claude/worktrees/a';
  assert.equal(hooksSource({ hooksPath: '/repo/.husky/_', worktree }), 'foreign');
  assert.equal(hooksSource({ hooksPath: `${worktree}/.husky/_`, worktree }), 'own');
  assert.equal(hooksSource({ hooksPath: '.husky/_', worktree }), 'own');
  assert.equal(hooksSource({ hooksPath: undefined, worktree }), 'default');
});
