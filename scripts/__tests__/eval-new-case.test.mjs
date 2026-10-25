import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { load as loadYaml } from 'js-yaml';
import {
  buildCaseSkeleton,
  caseIdFromTitle,
  extractPrRefs,
  isSourceFile,
  parseNewCaseArgs,
  planNewCase,
  shellQuote,
  writeCaseSkeleton,
} from '../eval-new-case.mjs';

const FIX_SHA = 'a'.repeat(40);
const SRC_SHA = 'b'.repeat(40);
const SRC_PARENT = 'c'.repeat(40);

/** Fake exec: answers from a table keyed by "command arg arg…", records calls. */
function fakeExec(table) {
  const calls = [];
  return {
    calls,
    run(command, args) {
      const key = [command, ...args].join(' ');
      calls.push(key);
      const hit = table[key];
      if (hit === undefined) return { status: 1, stdout: '', stderr: `unexpected: ${key}` };
      return typeof hit === 'string' ? { status: 0, stdout: hit, stderr: '' } : hit;
    },
  };
}

const PR_FIELDS = 'title,mergeCommit,body,files';
const prJson = (fields) => JSON.stringify(fields);

function standardTable() {
  return {
    [`gh pr view 1151 --json ${PR_FIELDS}`]: prJson({
      title: 'fix(mcp): resolve runner auth variables once (#1151)',
      mergeCommit: { oid: FIX_SHA },
      body: 'Fixes the runner auth override introduced in #1131. See also #1126 and #1151.',
      files: [{ path: 'src/features/mcp/protocol.ts' }],
    }),
    [`git log -1 --format=%B ${FIX_SHA}`]:
      'fix(mcp): resolve runner auth (#1151)\n\nfollow-up to #1131\n',
    [`gh pr view 1131 --json ${PR_FIELDS}`]: prJson({
      title: 'feat(mcp): collection runner (#1131)',
      mergeCommit: { oid: SRC_SHA },
      body: '',
      files: [
        { path: 'src/features/mcp/lib/mcpRunRequest.ts' },
        { path: 'src/features/mcp/lib/__tests__/mcpRunRequest.test.ts' },
        { path: 'docs/MCP.md' },
        { path: 'shared/protocol/mcp-run.ts' },
      ],
    }),
    [`gh pr view 1126 --json ${PR_FIELDS}`]: { status: 1, stdout: '', stderr: 'not found' },
    [`git rev-parse --verify ${SRC_SHA}^1`]: `${SRC_PARENT}\n`,
  };
}

test('parseNewCaseArgs requires --from <number> and accepts --id', () => {
  assert.deepEqual(parseNewCaseArgs(['--from', '1151']), { from: 1151, id: null });
  assert.deepEqual(parseNewCaseArgs(['--from', '#1151', '--id', 'my-case']), {
    from: 1151,
    id: 'my-case',
  });
  assert.throws(() => parseNewCaseArgs([]), /--from/);
  assert.throws(() => parseNewCaseArgs(['--from', 'abc']), /--from/);
  assert.throws(() => parseNewCaseArgs(['--from', '1', '--id', 'Bad Id']), /kebab/);
  assert.throws(() => parseNewCaseArgs(['--from', '1', '--wat']), /unknown/);
});

test('extractPrRefs returns unique #refs in order, without the excluded PR', () => {
  assert.deepEqual(extractPrRefs('see #1131, #1126 and #1131 (#1151)', [1151]), [1131, 1126]);
  assert.deepEqual(extractPrRefs('', []), []);
  assert.deepEqual(extractPrRefs('issue#12 is not a ref, but (#34) is', []), [34]);
});

test('caseIdFromTitle drops the conventional prefix and PR number', () => {
  assert.equal(
    caseIdFromTitle('fix(mcp): resolve runner auth variables once (#1151)'),
    'resolve-runner-auth-variables-once'
  );
  assert.equal(caseIdFromTitle('Fix: GraphQL GET!!'), 'graphql-get');
  assert.equal(caseIdFromTitle('fix(mcp): close seams (#1122 × #1126) (#1160)'), 'close-seams');
  assert.match(caseIdFromTitle('x'.repeat(200)), /^[a-z0-9-]{1,60}$/);
});

test('isSourceFile keeps product source and drops tests, docs and lockfiles', () => {
  assert.equal(isSourceFile('src/features/mcp/protocol.ts'), true);
  assert.equal(isSourceFile('electron/main/handlers/mcp-handler.ts'), true);
  assert.equal(isSourceFile('src/a/__tests__/b.test.ts'), false);
  assert.equal(isSourceFile('shared/x.test.ts'), false);
  assert.equal(isSourceFile('tests/security/x.ts'), false);
  assert.equal(isSourceFile('docs/MCP.md'), false);
  assert.equal(isSourceFile('package-lock.json'), false);
  assert.equal(isSourceFile('e2e/foo.spec.ts'), false);
});

test('planNewCase finds the fix, guesses source PRs and proposes base = first parent', () => {
  const exec = fakeExec(standardTable());
  const plan = planNewCase(exec, { from: 1151, id: null });
  assert.equal(plan.id, 'resolve-runner-auth-variables-once');
  assert.equal(plan.fix.mergeSha, FIX_SHA);
  assert.deepEqual(
    plan.sources.map((s) => s.number),
    [1131]
  );
  assert.deepEqual(plan.unresolvedRefs, [1126]);
  assert.equal(plan.base, SRC_PARENT);
  assert.deepEqual(plan.sources[0].sourceFiles, [
    'src/features/mcp/lib/mcpRunRequest.ts',
    'shared/protocol/mcp-run.ts',
  ]);
  // Read-only: only `gh pr view` and read-only git commands.
  for (const call of exec.calls) assert.match(call, /^(gh pr view |git (log|rev-parse) )/);
  assert.ok(plan.steps.some((s) => s.includes(`git diff ${SRC_PARENT} ${SRC_SHA} --`)));
  assert.ok(
    plan.steps.some((s) => s.includes('--dry-run --case resolve-runner-auth-variables-once'))
  );
});

test('planNewCase leaves base as a TODO when no source PR resolves', () => {
  const table = standardTable();
  table[`gh pr view 1131 --json ${PR_FIELDS}`] = { status: 1, stdout: '', stderr: 'nope' };
  const plan = planNewCase(fakeExec(table), { from: 1151, id: 'x-case' });
  assert.equal(plan.id, 'x-case');
  assert.equal(plan.base, null);
  assert.deepEqual(plan.sources, []);
  assert.match(plan.yaml, /base: TODO/);
});

test('planNewCase throws when the fix PR is not merged', () => {
  const table = standardTable();
  table[`gh pr view 1151 --json ${PR_FIELDS}`] = prJson({
    title: 't',
    mergeCommit: null,
    body: '',
    files: [],
  });
  assert.throws(() => planNewCase(fakeExec(table), { from: 1151, id: null }), /not merged/);
});

test('buildCaseSkeleton is parseable YAML with TODOs and the guessed fields', () => {
  const yaml = buildCaseSkeleton({
    id: 'my-case',
    title: 'fix: thing (#9)',
    fixNumber: 9,
    sources: [{ number: 7, mergeSha: SRC_SHA, sourceFiles: ['src/a.ts'] }],
    base: SRC_PARENT,
  });
  const parsed = loadYaml(yaml);
  assert.equal(parsed.id, 'my-case');
  assert.equal(parsed.origin, 'real');
  assert.equal(parsed.split, 'train');
  assert.deepEqual(parsed.sourcePRs, ['#7']);
  assert.deepEqual(parsed.fixPRs, ['#9']);
  assert.equal(parsed.base, SRC_PARENT);
  assert.deepEqual(parsed.expected.files, ['src/a.ts']);
  assert.match(yaml, /TODO/);
  assert.ok(parsed.mustMention.length > 0);
});

test('writeCaseSkeleton refuses to overwrite an existing case', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-new-case-'));
  try {
    const file = writeCaseSkeleton(dir, 'abc', 'id: abc\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'id: abc\n');
    assert.throws(() => writeCaseSkeleton(dir, 'abc', 'id: other\n'), /exists/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'id: abc\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const HOSTILE = ['src/a: b.ts', 'src/#hash.ts', 'src/$(touch pwned).ts', "src/it's.ts"];

test('shellQuote single-quotes with the close-escape-reopen idiom', () => {
  assert.equal(shellQuote('src/a.ts'), "'src/a.ts'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote('$(x)'), "'$(x)'");
});

test('hostile PR file paths are quoted in the YAML and shell-quoted in the printed steps', () => {
  const table = standardTable();
  table[`gh pr view 1131 --json ${PR_FIELDS}`] = prJson({
    title: 'feat: x (#1131)',
    mergeCommit: { oid: SRC_SHA },
    body: '',
    files: HOSTILE.map((p) => ({ path: p })),
  });
  const plan = planNewCase(fakeExec(table), { from: 1151, id: 'hostile' });
  const parsed = loadYaml(plan.yaml);
  assert.deepEqual(parsed.expected.files, HOSTILE);
  const diff = plan.steps.find((s) => s.startsWith('git diff'));
  for (const p of HOSTILE) assert.ok(diff.includes(shellQuote(p)), `${p} in ${diff}`);
  assert.doesNotMatch(diff, / src\/\$\(touch/);
});

test('planNewCase rejects a PR file path containing a newline', () => {
  const table = standardTable();
  table[`gh pr view 1131 --json ${PR_FIELDS}`] = prJson({
    title: 'feat: x (#1131)',
    mergeCommit: { oid: SRC_SHA },
    body: '',
    files: [{ path: 'src/ok.ts' }, { path: 'src/evil\nrm -rf ~.ts' }],
  });
  assert.throws(() => planNewCase(fakeExec(table), { from: 1151, id: 'nl' }), /newline/);
});
