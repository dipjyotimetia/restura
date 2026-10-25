import assert from 'node:assert/strict';
import test from 'node:test';
import { findStagedViolations, parseAddedLines, parseRawDiff } from '../guard-staged.mjs';

const context = {
  repoRoots: ['/work/checkouts/restura/.claude/worktrees/agent-1', '/work/checkouts/restura'],
  repoName: 'restura',
};
const entry = (path, overrides = {}) => ({ path, mode: '100644', addedLines: [], ...overrides });
const check = (...entries) => findStagedViolations(entries, context);

test('accepts ordinary source files', () => {
  assert.deepEqual(check(entry('src/a.ts', { addedLines: ["import x from './x';"] })), []);
});

test('rejects new symlinks, including a worktree node_modules-free absolute link', () => {
  const [problem] = check(entry('tools/link', { mode: '120000', symlinkTarget: '/opt/x' }));
  assert.match(problem, /new symlink -> \/opt\/x/);
});

test('allows relative skill symlinks but not absolute ones under the allow-list', () => {
  assert.deepEqual(
    check(
      entry('.claude/skills/tdd', { mode: '120000', symlinkTarget: '../../.agents/skills/tdd' })
    ),
    []
  );
  assert.equal(
    check(entry('.claude/skills/x', { mode: '120000', symlinkTarget: '/Users/me/skills/x' }))
      .length,
    1
  );
});

test('rejects any node_modules path segment, symlink or not', () => {
  assert.match(
    check(entry('extension/vscode/node_modules', { mode: '120000' }))[0],
    /node_modules/
  );
  assert.match(check(entry('cli/node_modules/pkg/index.js'))[0], /node_modules/);
  assert.deepEqual(check(entry('docs/node_modules-guide.md')), []);
});

test('rejects .dev.vars and snapshot files', () => {
  assert.match(check(entry('.dev.vars'))[0], /local Worker secrets/);
  assert.match(check(entry('src/__snapshots__/a.test.ts.snap'))[0], /toMatchInlineSnapshot/);
});

// Built at runtime so this file does not trip the guard it tests.
const homePath = (...parts) => ['', ...parts].join('/');

test('rejects added lines leaking this checkout or a home-directory repo path', () => {
  assert.equal(check(entry('a.md', { addedLines: ['cd /work/checkouts/restura/src'] })).length, 1);
  assert.equal(
    check(
      entry('a.md', {
        addedLines: [`see ${homePath('Users', 'alice', 'code', 'restura', 'docs')}`],
      })
    ).length,
    1
  );
  assert.equal(
    check(entry('a.md', { addedLines: [`"${homePath('home', 'bob', 'restura')}"`] })).length,
    1
  );
});

test('keeps false positives low for generic home paths in fixtures', () => {
  assert.deepEqual(
    check(
      entry('electron/main/__tests__/x.test.ts', {
        addedLines: [
          "const p = '/Users/alice/project/file.txt';",
          '/home/runner/restura-cli-cache',
        ],
      })
    ),
    []
  );
});

test('parses raw diff output and drops deletions', () => {
  const raw = [
    ':000000 100644 0000000 aaaaaaa A',
    'src/new.ts',
    ':100644 000000 bbbbbbb 0000000 D',
    'src/gone.ts',
    ':000000 120000 0000000 ccccccc A',
    'node_modules',
    '',
  ].join('\0');
  assert.deepEqual(parseRawDiff(raw), [
    { path: 'src/new.ts', mode: '100644', sha: 'aaaaaaa' },
    { path: 'node_modules', mode: '120000', sha: 'ccccccc' },
  ]);
});

test('collects only added lines per file from a zero-context patch', () => {
  const patch = [
    'diff --git a/a.md b/a.md',
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '+++ not a header',
    'diff --git a/b.md b/b.md',
    '--- /dev/null',
    '+++ b/b.md',
    '+hello',
  ].join('\n');
  assert.deepEqual(Object.fromEntries(parseAddedLines(patch)), {
    'a.md': ['new', '++ not a header'],
    'b.md': ['hello'],
  });
});

test('parseAddedLines strips the trailing tab git adds for paths with spaces', () => {
  const patch = ['--- a/My Notes.md\t', '+++ b/My Notes.md\t', '@@ -0,0 +1 @@', '+hi'].join('\n');
  assert.deepEqual(Object.fromEntries(parseAddedLines(patch)), { 'My Notes.md': ['hi'] });
});
