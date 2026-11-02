import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyHiddenTests,
  applyReferenceDiff,
  buildAgentArgs,
  buildAgentPrompt,
  classifyAgentRun,
  dryRunVerdict,
  evalExec,
  formatBuildMarkdown,
  gitChecks,
  gradeCommands,
  hiddenFilesFor,
  loadTasks,
  overlayLeakReport,
  PROMPT_SUFFIX,
  parseBuildArgs,
  requireTestsRan,
  restoreGraderFiles,
  runCommand,
  runTask,
  summariseBuild,
  TASKS_DIR,
  taskLeakTerms,
  transcriptMetrics,
  validateTask,
} from '../build-eval.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function rawTask(extra = {}) {
  return {
    id: 'demo-task',
    title: 'Demo',
    split: 'train',
    base: SHA_A,
    referenceCommit: SHA_B,
    issue: 'Sending a request with Bearer {{token}} sends the literal template.',
    hiddenTests: ['src/a.test.ts'],
    failToPass: ['npx vitest run src/a.test.ts --reporter=verbose'],
    passToPass: ['npm run type-check:all'],
    timeoutMinutes: 30,
    notes: 'n',
    ...extra,
  };
}

const okChecks = {
  resolveCommit: () => true,
  existsAt: () => true,
  firstParent: () => SHA_A,
};

// ---------------------------------------------------------------- arguments

test('parseBuildArgs: defaults and options', () => {
  const d = parseBuildArgs([]);
  assert.equal(d.runs, 2);
  assert.equal(d.maxBudgetUsd, 15);
  assert.equal(d.harnessRef, 'HEAD');
  assert.equal(d.split, 'all');
  assert.equal(d.out, '.claude/metrics/evals/build');
  assert.equal(d.dryRun, false);
  const o = parseBuildArgs([
    '--case',
    'x',
    '--case=y',
    '--split',
    'test',
    '--runs',
    '3',
    '--model',
    'opus',
    '--max-budget-usd',
    '5',
    '--config',
    'slim',
    '--harness-ref',
    'main',
    '--out',
    'o',
    '--dry-run',
  ]);
  assert.deepEqual(o.caseIds, ['x', 'y']);
  assert.equal(o.split, 'test');
  assert.equal(o.runs, 3);
  assert.equal(o.model, 'opus');
  assert.equal(o.maxBudgetUsd, 5);
  assert.equal(o.config, 'slim');
  assert.equal(o.harnessRef, 'main');
  assert.equal(o.out, 'o');
  assert.equal(o.dryRun, true);
  assert.throws(() => parseBuildArgs(['--runs', '0']), /--runs/);
  assert.throws(() => parseBuildArgs(['--split', 'dev']), /--split/);
  assert.throws(() => parseBuildArgs(['--bogus']), /Unknown option/);
  assert.throws(() => parseBuildArgs(['--max-budget-usd', '-1']), /budget/);
});

// ---------------------------------------------------------------- validation

test('validateTask accepts a well-formed task', () => {
  const r = validateTask(rawTask(), okChecks);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.value.commandTimeoutMinutes, 20);
});

test('validateTask reports every schema problem', () => {
  const r = validateTask(
    rawTask({
      id: 'Bad Id',
      split: 'dev',
      base: 'abc',
      referenceCommit: undefined,
      issue: '',
      hiddenTests: [],
      failToPass: [],
      passToPass: 'npm test',
      timeoutMinutes: 0,
    }),
    okChecks
  );
  assert.equal(r.ok, false);
  for (const re of [
    /id/,
    /split/,
    /base/,
    /referenceCommit/,
    /issue/,
    /hiddenTests/,
    /failToPass/,
    /passToPass/,
    /timeoutMinutes/,
  ])
    assert.ok(
      r.errors.some((e) => re.test(e)),
      `missing ${re}`
    );
});

test('validateTask: shas must resolve, base must be the first parent, hidden tests exist at ref', () => {
  const unresolved = validateTask(rawTask(), {
    ...okChecks,
    resolveCommit: (sha) => sha !== SHA_B,
  });
  assert.equal(unresolved.ok, false);
  assert.ok(unresolved.errors.some((e) => /referenceCommit .* does not resolve/.test(e)));
  const r = validateTask(rawTask(), {
    resolveCommit: () => true,
    existsAt: () => false,
    firstParent: () => 'c'.repeat(40),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /src\/a\.test\.ts.* not in referenceCommit/.test(e)));
  assert.ok(r.errors.some((e) => /first parent/.test(e)));
});

test('validateTask rejects an issue that leaks a hidden test path or name', () => {
  const leak = validateTask(
    rawTask({ issue: 'See src/a.test.ts for the failing case.' }),
    okChecks
  );
  assert.equal(leak.ok, false);
  assert.ok(leak.errors.some((e) => /issue must not name hidden test/.test(e)));
  const stem = validateTask(rawTask({ issue: 'a.test fails' }), okChecks);
  assert.equal(stem.ok, false);
});

test('validateTask: optional leakTerms must be a list of non-empty strings (default [])', () => {
  assert.deepEqual(validateTask(rawTask(), okChecks).value.leakTerms, []);
  const ok = validateTask(rawTask({ leakTerms: ['resolveMcpRunConnectAuth'] }), okChecks);
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  assert.deepEqual(ok.value.leakTerms, ['resolveMcpRunConnectAuth']);
  for (const bad of ['x', [''], [1], ['  ']]) {
    const r = validateTask(rawTask({ leakTerms: bad }), okChecks);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.errors.some((e) => /leakTerms/.test(e)));
  }
});

test('validateTask: vitest failToPass commands need --reporter=verbose (lists the files that ran)', () => {
  const r = validateTask(rawTask({ failToPass: ['npx vitest run src/a.test.ts'] }), okChecks);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /--reporter=verbose/.test(e)));
});

test('validateTask rejects hidden test paths that escape the repo', () => {
  const r = validateTask(rawTask({ hiddenTests: ['../x.test.ts', '/etc/x.test.ts'] }), okChecks);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /relative repo path/.test(e)));
});

test('loadTasks: id must match file name; split and id filters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'demo-task.yaml'), JSON.stringify(rawTask()));
    fs.writeFileSync(
      path.join(dir, 'other.yaml'),
      JSON.stringify(rawTask({ id: 'other', split: 'test' }))
    );
    assert.equal(loadTasks({ dir, check: okChecks }).length, 2);
    assert.deepEqual(
      loadTasks({ dir, split: 'test', check: okChecks }).map((t) => t.id),
      ['other']
    );
    assert.throws(() => loadTasks({ dir, ids: ['nope'], check: okChecks }), /Unknown task/);
    assert.throws(
      () => loadTasks({ dir, ids: ['demo-task'], split: 'test', check: okChecks }),
      /not in split/
    );
    fs.writeFileSync(path.join(dir, 'mismatch.yaml'), JSON.stringify(rawTask({ id: 'zzz' })));
    assert.throws(() => loadTasks({ dir, check: okChecks }), /must match the file name/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// CI's static job checks out shallow, so task base/reference commits are absent there;
// the full-history check runs locally and in the eval workflow (fetch-depth: 0).
const shallow =
  spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-shallow-repository'], {
    encoding: 'utf8',
  }).stdout.trim() === 'true';

test('committed tasks validate against this repo and keep a train/test split', {
  skip: shallow && 'shallow clone: task commits are not fetched',
}, () => {
  const tasks = loadTasks({ dir: TASKS_DIR, check: gitChecks(ROOT) });
  assert.ok(tasks.length >= 5, 'expected at least 5 seeded tasks');
  assert.ok(tasks.some((t) => t.split === 'test'));
  assert.ok(tasks.some((t) => t.split === 'train'));
});

// ---------------------------------------------------------------- agent

test('buildAgentPrompt appends the fixed suffix and nothing from the answer key', () => {
  const task = validateTask(rawTask({ notes: 'ANSWER-KEY-NOTE' }), okChecks).value;
  const prompt = buildAgentPrompt(task);
  assert.ok(prompt.startsWith(task.issue.trim()));
  assert.ok(prompt.endsWith(PROMPT_SUFFIX));
  assert.match(PROMPT_SUFFIX, /CLAUDE\.md/);
  assert.match(PROMPT_SUFFIX, /Commit your work/);
  assert.match(PROMPT_SUFFIX, /Do not push or open PRs/);
  for (const secret of [task.referenceCommit, ...task.hiddenTests, task.notes])
    assert.ok(!prompt.includes(secret));
});

test('buildAgentArgs: stream-json, dontAsk, budget, model, tools, no push/gh', () => {
  const args = buildAgentArgs({ model: 'opus', maxBudgetUsd: 7 });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--output-format'), 'stream-json');
  assert.ok(args.includes('--verbose'));
  assert.equal(at('--permission-mode'), 'dontAsk');
  assert.equal(at('--max-budget-usd'), '7');
  assert.equal(at('--model'), 'opus');
  for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Skill', 'Task'])
    assert.ok(args.includes(tool));
  assert.ok(args.includes('Bash(git push:*)'));
  assert.ok(args.includes('Bash(gh:*)'));
  const denied = args.slice(args.indexOf('--disallowedTools') + 1);
  for (const tool of ['Bash(curl:*)', 'Bash(wget:*)', 'WebFetch', 'WebSearch'])
    assert.ok(denied.includes(tool), `${tool} must be disallowed`);
  assert.ok(!buildAgentArgs({ maxBudgetUsd: 1 }).includes('--model'));
});

function stream(events) {
  return events.map((e) => JSON.stringify(e)).join('\n');
}
const bash = (command) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
});

test('transcriptMetrics: turns, cost, minutes, tools, verification habits', () => {
  const m = transcriptMetrics(
    stream([
      bash('npm run type-check:all'),
      bash('npx vitest run src/x.test.ts'),
      bash('git commit -m fix'),
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'tdd' } }] },
      },
      {
        type: 'result',
        subtype: 'success',
        num_turns: 9,
        total_cost_usd: 1.5,
        duration_ms: 120000,
      },
    ])
  );
  assert.equal(m.turns, 9);
  assert.equal(m.costUsd, 1.5);
  assert.equal(m.minutes, 2);
  assert.equal(m.ranTypeCheckAll, true);
  assert.equal(m.ranTests, true);
  assert.equal(m.ranCommit, true);
  assert.deepEqual(m.toolStats.skills, ['tdd']);
  const none = transcriptMetrics(
    stream([bash('npm run type-check'), { type: 'result', subtype: 'success', num_turns: 1 }])
  );
  assert.equal(none.ranTypeCheckAll, false, 'renderer-only type-check is not type-check:all');
  assert.equal(none.ranTests, false);
  assert.equal(transcriptMetrics('garbage').turns, null);
});

// ---------------------------------------------------------------- grading

function fakeExec(handler) {
  const calls = [];
  return {
    calls,
    async run(command, args, opts = {}) {
      calls.push({ command, args, opts });
      return handler(command, args, opts) ?? { status: 0, stdout: '', stderr: '' };
    },
    async pipe(from, to, opts = {}) {
      calls.push({ pipe: [from, to], opts });
      return handler('pipe', [from, to], opts) ?? { status: 0, stdout: '', stderr: '' };
    },
  };
}

const vitestOut = (file, { passed = 3, failed = 0 } = {}) =>
  [
    ` ${failed ? '×' : '✓'} ${file} > suite > case 3ms`,
    ` Test Files  ${failed ? '1 failed' : '1 passed'} (1)`,
    `      Tests  ${failed ? `${failed} failed | ` : ''}${passed} passed (${passed + failed})`,
  ].join('\n');

test('runCommand: bash -c in its own process group, tail, test count, hidden file named', async () => {
  const exec = fakeExec(() => ({
    status: 1,
    stdout: `${'x'.repeat(5000)}\n${vitestOut('src/a.test.ts', { failed: 1 })}`,
    stderr: 'boom',
  }));
  const r = await runCommand(exec, 'npm test', {
    cwd: '/r',
    timeoutMs: 1000,
    expectFiles: ['a.test.ts'],
  });
  assert.equal(exec.calls[0].command, 'bash');
  assert.deepEqual(exec.calls[0].args, ['-c', 'npm test']);
  assert.equal(exec.calls[0].opts.cwd, '/r');
  assert.equal(exec.calls[0].opts.timeout, 1000);
  assert.equal(
    exec.calls[0].opts.detached,
    true,
    'graders run detached so the group can be killed'
  );
  assert.equal(r.status, 'fail');
  assert.equal(r.exitCode, 1);
  assert.equal(r.testsRun, 4);
  assert.equal(r.namesHiddenFile, true);
  assert.ok(r.tail.length <= 2000);
  assert.ok(r.tail.includes('boom'));
  const timedOut = await runCommand(
    fakeExec(() => ({
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: 'timed out after 1 ms',
    })),
    'x',
    { cwd: '/r', timeoutMs: 1 }
  );
  assert.equal(timedOut.status, 'timeout');
  const none = await runCommand(
    fakeExec(() => ({ status: 1, stdout: 'No test files found, exiting with code 1' })),
    'x',
    { cwd: '/r', timeoutMs: 1, expectFiles: ['a.test.ts'] }
  );
  assert.equal(none.testsRun, null);
  assert.equal(none.namesHiddenFile, false);
});

test('requireTestsRan: a passing failToPass that ran no tests, or not the hidden file, fails', () => {
  const pass = { command: 'c', status: 'pass', testsRun: 3, namesHiddenFile: true };
  assert.equal(requireTestsRan(pass).status, 'pass');
  for (const bad of [
    { ...pass, testsRun: 0 },
    { ...pass, testsRun: null },
    { ...pass, namesHiddenFile: false },
  ]) {
    const r = requireTestsRan(bad);
    assert.equal(r.status, 'fail');
    assert.match(r.note, /no tests|hidden test/);
  }
  assert.equal(requireTestsRan({ ...pass, status: 'fail' }).status, 'fail');
});

test('hiddenFilesFor: hidden basenames named by the command, else all of them', () => {
  const hidden = ['src/a.test.ts', 'cli/src/b.test.ts'];
  assert.deepEqual(hiddenFilesFor('cd cli && npx vitest run src/b.test.ts', hidden), ['b.test.ts']);
  assert.deepEqual(hiddenFilesFor('npx vitest run src', hidden), ['a.test.ts', 'b.test.ts']);
});

test('gradeCommands: pass needs every command; fraction is over failToPass; passToPass is a flag', () => {
  const pass = { status: 'pass' };
  const fail = { status: 'fail' };
  assert.deepEqual(gradeCommands({ failToPass: [pass], passToPass: [pass, pass] }), {
    outcome: 'pass',
    failToPassFraction: 1,
    passToPassBroken: false,
  });
  assert.deepEqual(gradeCommands({ failToPass: [fail, pass], passToPass: [pass] }), {
    outcome: 'fail',
    failToPassFraction: 0.5,
    passToPassBroken: false,
  });
  assert.deepEqual(gradeCommands({ failToPass: [pass], passToPass: [fail] }), {
    outcome: 'fail',
    failToPassFraction: 1,
    passToPassBroken: true,
  });
  assert.equal(gradeCommands({ failToPass: [], passToPass: [] }).outcome, 'fail');
});

test('applyHiddenTests writes each hidden test from the reference commit, overwriting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/a.test.ts'), 'agent version');
    const exec = fakeExec((cmd, args) =>
      cmd === 'git' && args.includes('show')
        ? { status: 0, stdout: `content of ${args.at(-1)}`, stderr: '' }
        : undefined
    );
    await applyHiddenTests(exec, {
      repo: '/main',
      dir,
      ref: SHA_B,
      paths: ['src/a.test.ts', 'cli/src/b.test.ts'],
    });
    assert.equal(
      fs.readFileSync(path.join(dir, 'src/a.test.ts'), 'utf8'),
      `content of ${SHA_B}:src/a.test.ts`
    );
    assert.ok(fs.existsSync(path.join(dir, 'cli/src/b.test.ts')));
    assert.deepEqual(exec.calls[0].args, ['-C', '/main', 'show', `${SHA_B}:src/a.test.ts`]);
    const failing = fakeExec(() => ({ status: 128, stdout: '', stderr: 'bad path' }));
    await assert.rejects(
      applyHiddenTests(failing, { repo: '/main', dir, ref: SHA_B, paths: ['src/a.test.ts'] }),
      /bad path/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyReferenceDiff pipes base..ref (minus node_modules) into git apply in the isolated repo', async () => {
  const exec = fakeExec(() => undefined);
  await applyReferenceDiff(exec, { repo: '/main', dir: '/iso', base: SHA_A, ref: SHA_B });
  const [from, to] = exec.calls[0].pipe;
  assert.equal(from[0], 'git');
  assert.deepEqual(from[1].slice(0, 6), ['-C', '/main', 'diff', '--binary', SHA_A, SHA_B]);
  assert.ok(from[1].some((a) => a.includes('exclude') && a.includes('node_modules')));
  assert.deepEqual(to, ['git', ['-C', '/iso', 'apply', '--whitespace=nowarn']]);
  const bad = fakeExec(() => ({ status: 1, stdout: '', stderr: 'patch does not apply' }));
  await assert.rejects(
    applyReferenceDiff(bad, { repo: '/main', dir: '/iso', base: SHA_A, ref: SHA_B }),
    /does not apply/
  );
});

test('dryRunVerdict: base failToPass must FAIL naming the hidden file; base passToPass green; reference all green', () => {
  const p = { status: 'pass', command: 'p', namesHiddenFile: true };
  const f = { status: 'fail', command: 'f', namesHiddenFile: true };
  assert.deepEqual(
    dryRunVerdict({
      atBase: [f, f],
      passToPassAtBase: [p],
      atReference: { failToPass: [p, p], passToPass: [p] },
    }),
    { ok: true, problems: [] }
  );
  const bad = dryRunVerdict({
    atBase: [p, { ...f, status: 'timeout' }, { ...f, namesHiddenFile: false }],
    passToPassAtBase: [f],
    atReference: { failToPass: [p, f], passToPass: [f] },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 6);
  assert.ok(bad.problems.some((x) => /passes on base/.test(x)));
  assert.ok(bad.problems.some((x) => /timeout on base/.test(x)));
  assert.ok(bad.problems.some((x) => /does not name the hidden test/.test(x)));
  assert.ok(bad.problems.some((x) => /passToPass fail on base/.test(x)));
});

test('restoreGraderFiles: reverts grader-critical files the agent touched and lists them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  const eb = 'e'.repeat(40);
  try {
    fs.writeFileSync(path.join(dir, 'vitest.config.ts'), "setupFiles: ['./tests/setup.ts'],");
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude/settings.json'), '{}');
    const exec = fakeExec((_cmd, args) => {
      if (args.includes('diff')) return { status: 0, stdout: 'vitest.config.ts\ntests/setup.ts\n' };
      if (args.includes('ls-files')) return { status: 0, stdout: '.claude/settings.json\n' };
      if (args.includes('cat-file'))
        return { status: args.at(-1).endsWith('.claude/settings.json') ? 1 : 0 };
      return undefined;
    });
    const touched = await restoreGraderFiles(exec, dir, eb);
    assert.deepEqual(touched, ['.claude/settings.json', 'tests/setup.ts', 'vitest.config.ts']);
    const diffCall = exec.calls.find((c) => c.args.includes('diff'));
    for (const spec of ['package.json', 'cli/package.json', '.claude', 'tests/setup.ts'])
      assert.ok(diffCall.args.includes(spec), `pathspec ${spec}`);
    assert.ok(diffCall.args.some((a) => a.includes('tsconfig')));
    assert.ok(diffCall.args.some((a) => a.includes('vitest.config')));
    const checkouts = exec.calls
      .filter((c) => c.args.includes('checkout'))
      .map((c) => c.args.at(-1));
    assert.deepEqual(checkouts.sort(), ['tests/setup.ts', 'vitest.config.ts']);
    assert.ok(!fs.existsSync(path.join(dir, '.claude/settings.json')), 'agent-added file removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- runTask

function runTaskExec({ agentStdout, commandStatus = () => 0, commits = '1', handler }) {
  return fakeExec((cmd, args, opts) => {
    const custom = handler?.(cmd, args, opts);
    if (custom) return custom;
    if (cmd === 'claude') return { status: 0, stdout: agentStdout, stderr: '' };
    if (cmd === 'bash') {
      const status = commandStatus(args[1]);
      return {
        status,
        stdout: `ran ${args[1]}\n${vitestOut('src/a.test.ts', status ? { failed: 1 } : {})}`,
        stderr: '',
      };
    }
    if (cmd === 'git' && args.includes('rev-list')) return { status: 0, stdout: `${commits}\n` };
    if (cmd === 'git' && args.includes('status')) return { status: 0, stdout: '' };
    if (cmd === 'git' && args.includes('show')) return { status: 0, stdout: 'hidden test' };
    if (cmd === 'git' && args.includes('rev-parse'))
      return { status: 0, stdout: `${'e'.repeat(40)}\n` };
    return undefined;
  });
}

function ctxFor(exec, tempDir, extra = {}) {
  return {
    exec,
    repo: '/main',
    tempDir,
    harnessSha: SHA_B,
    forbiddenRoots: ['/main'],
    createRepo: async () => ({ harnessSha: SHA_B, effectiveBase: 'e'.repeat(40) }),
    setup: () => {},
    ...extra,
  };
}

const goodStream = stream([
  bash('npm run type-check:all'),
  { type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 2, duration_ms: 60000 },
]);

test('runTask grades the outcome state: grader files restored, hidden tests added after the agent', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    const exec = runTaskExec({
      agentStdout: goodStream,
      handler: (cmd, args) =>
        cmd === 'git' && args.includes('diff') && args.includes('--name-only')
          ? { status: 0, stdout: 'package.json\n' }
          : undefined,
    });
    const out = await runTask(task, ctxFor(exec, tempDir));
    assert.equal(out.status, 'ok', out.reason);
    assert.equal(out.outcome, 'pass');
    assert.equal(out.failToPassFraction, 1);
    assert.equal(out.passToPassBroken, false);
    assert.deepEqual(out.graderFilesTouched, ['package.json']);
    assert.equal(out.agent.costUsd, 2);
    assert.equal(out.committed, true);
    const idx = (pred) => exec.calls.findIndex(pred);
    const claudeAt = idx((c) => c.command === 'claude');
    const restoreAt = idx((c) => c.command === 'git' && c.args.includes('--name-only'));
    const showAt = idx((c) => c.command === 'git' && c.args.includes('show'));
    const firstBash = idx((c) => c.command === 'bash');
    assert.ok(claudeAt >= 0 && claudeAt < restoreAt, 'grader files restored after the agent');
    assert.ok(restoreAt < showAt, 'then hidden tests applied');
    assert.ok(showAt < firstBash, 'graders run after the hidden tests are in place');
    const claudeCall = exec.calls[claudeAt];
    assert.ok(claudeCall.opts.input.endsWith(PROMPT_SUFFIX));
    assert.equal(claudeCall.opts.timeout, 30 * 60 * 1000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask: failing failToPass → fail, fraction over failToPass, per-command tails', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    const exec = runTaskExec({
      agentStdout: goodStream,
      commandStatus: (c) => (c.includes('vitest') ? 1 : 0),
      commits: '0',
    });
    const out = await runTask(task, ctxFor(exec, tempDir));
    assert.equal(out.outcome, 'fail');
    assert.equal(out.failToPassFraction, 0);
    assert.equal(out.passToPassBroken, false);
    assert.equal(out.commands.failToPass[0].status, 'fail');
    assert.match(out.commands.failToPass[0].tail, /ran npx vitest/);
    assert.equal(out.committed, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask: a failToPass that exits 0 without running the hidden tests is a fail', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    const exec = runTaskExec({
      agentStdout: goodStream,
      handler: (cmd, args) =>
        cmd === 'bash' && args[1].includes('vitest')
          ? { status: 0, stdout: 'No test files found, exiting with code 0' }
          : undefined,
    });
    const out = await runTask(task, ctxFor(exec, tempDir));
    assert.equal(out.outcome, 'fail');
    assert.equal(out.commands.failToPass[0].status, 'fail');
    assert.match(out.commands.failToPass[0].note, /no tests/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask: a contaminated transcript is a graded FAIL (score 0), flagged, not graded further', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    const exec = runTaskExec({
      agentStdout: stream([
        bash('git -C /main log --all'),
        { type: 'result', subtype: 'success', num_turns: 1 },
      ]),
    });
    const out = await runTask(task, ctxFor(exec, tempDir));
    assert.equal(out.status, 'ok');
    assert.equal(out.outcome, 'fail');
    assert.equal(out.failToPassFraction, 0);
    assert.equal(out.contaminated, true);
    assert.ok(out.contamination.length > 0);
    assert.ok(!exec.calls.some((c) => c.command === 'bash'), 'no grading for a contaminated run');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('grader tails and transcripts are redacted with redactSecrets', async () => {
  const secret = 'sk-build-eval-test-secret-0123456789';
  const previous = process.env.BUILD_EVAL_TEST_API_TOKEN;
  process.env.BUILD_EVAL_TEST_API_TOKEN = secret;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const r = await runCommand(
      fakeExec(() => ({ status: 1, stdout: `token=${secret}`, stderr: '' })),
      'env',
      { cwd: '/r', timeoutMs: 1 }
    );
    assert.ok(!r.tail.includes(secret));
    assert.match(r.tail, /REDACTED/);

    const task = validateTask(rawTask(), okChecks).value;
    const transcriptFile = path.join(tempDir, 'out', 't.jsonl');
    const leaky = stream([
      bash(`echo ${secret}`),
      { type: 'result', subtype: 'success', num_turns: 2 },
    ]);
    await runTask(task, ctxFor(runTaskExec({ agentStdout: leaky }), tempDir, { transcriptFile }));
    assert.ok(!fs.readFileSync(transcriptFile, 'utf8').includes(secret));
  } finally {
    if (previous === undefined) delete process.env.BUILD_EVAL_TEST_API_TOKEN;
    else process.env.BUILD_EVAL_TEST_API_TOKEN = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('classifyAgentRun: timeout/budget/max-turns are incomplete (graded fail); the rest is aligned with harness-eval', () => {
  const ok = (events, extra = {}) => ({ status: 0, stdout: stream(events), stderr: '', ...extra });
  const result = (extra) => ({ type: 'result', subtype: 'success', num_turns: 4, ...extra });
  assert.equal(classifyAgentRun(ok([result()])).status, 'ok');
  const timedOut = { status: null, signal: 'SIGTERM', stderr: 'timed out after 60000 ms' };
  for (const [label, raw, re] of [
    ['budget', ok([result({ subtype: 'error_max_budget_usd', is_error: true })]), /budget/],
    [
      'budget, non-zero exit',
      ok([result({ subtype: 'error_max_budget_usd' })], { status: 1 }),
      /budget/,
    ],
    ['max turns', ok([result({ subtype: 'error_max_turns', is_error: true })]), /max turns/],
    ['timeout', ok([result()], timedOut), /timed out/],
    ['timeout, no stream', { stdout: '', ...timedOut }, /timed out/],
  ]) {
    const c = classifyAgentRun(raw);
    assert.equal(c.status, 'incomplete', label);
    assert.match(c.reason, re, label);
  }
  for (const [label, raw] of [
    ['spawn failure', { status: 1, stdout: '', stderr: 'spawn claude ENOENT' }],
    ['killed by a signal (not our timeout)', ok([result()], { status: null, signal: 'SIGKILL' })],
    ['unparseable', { status: 0, stdout: 'not json', stderr: '' }],
    ['zero turns', ok([result({ num_turns: 0 })])],
    ['non-zero exit after success', ok([result()], { status: 1 })],
    ['error subtype', ok([result({ subtype: 'error_during_execution' })])],
    ['is_error', ok([result({ is_error: true })])],
  ])
    assert.equal(classifyAgentRun(raw).status, 'error', label);
});

test('runTask: budget, max-turns and timeout are incomplete → graded fail, score 0; a crash is excluded', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    const crash = await runTask(task, ctxFor(runTaskExec({ agentStdout: '' }), tempDir));
    assert.equal(crash.status, 'error');
    assert.equal(crash.outcome, null);
    for (const subtype of ['error_max_budget_usd', 'error_max_turns']) {
      const exec = runTaskExec({
        agentStdout: stream([{ type: 'result', subtype, is_error: true, num_turns: 50 }]),
      });
      const out = await runTask(task, ctxFor(exec, tempDir));
      assert.equal(out.status, 'ok', subtype);
      assert.equal(out.outcome, 'fail', subtype);
      assert.equal(out.failToPassFraction, 0, subtype);
      assert.equal(out.incomplete, true, subtype);
      assert.ok(out.incompleteReason, subtype);
      assert.ok(!exec.calls.some((c) => c.command === 'bash'), `${subtype}: not graded`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask: a changed shared node_modules fingerprint is a harness error with a loud reason', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    let calls = 0;
    const exec = runTaskExec({ agentStdout: goodStream });
    const out = await runTask(
      task,
      ctxFor(exec, tempDir, {
        fingerprint: () => {
          calls += 1;
          return calls === 1 ? 'before' : 'after';
        },
      })
    );
    assert.equal(out.status, 'error');
    assert.equal(out.sharedNodeModulesModified, true);
    assert.match(
      out.reason,
      /agent modified shared node_modules — run npm ci in the main checkout/
    );
    assert.ok(!exec.calls.some((c) => c.command === 'bash'), 'not graded');
    const claudeAt = exec.calls.findIndex((c) => c.command === 'claude');
    assert.ok(claudeAt >= 0);
    let same = 0;
    const clean = await runTask(
      task,
      ctxFor(runTaskExec({ agentStdout: goodStream }), tempDir, {
        fingerprint: () => {
          same += 1;
          return 'stable';
        },
      })
    );
    assert.equal(clean.status, 'ok', clean.reason);
    assert.equal(same, 2, 'fingerprinted before and after the agent');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask strips the answer keys (evals/), prunes them from the object store, records hidden tests at base', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    const dir = path.join(tempDir, 'repo');
    const exec = runTaskExec({ agentStdout: goodStream });
    const out = await runTask(
      task,
      ctxFor(exec, tempDir, {
        createRepo: async () => {
          fs.mkdirSync(path.join(dir, 'evals/build/tasks'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'evals/build/tasks/demo-task.yaml'), 'answer');
          fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'src/a.test.ts'), 'base version');
          return { harnessSha: SHA_B, effectiveBase: 'd'.repeat(40) };
        },
      })
    );
    assert.equal(out.status, 'ok', out.reason);
    assert.ok(!fs.existsSync(path.join(dir, 'evals')));
    const gitArgs = exec.calls.filter((c) => c.command === 'git').map((c) => c.args.join(' '));
    assert.ok(gitArgs.some((a) => a.includes('rm -r -q --ignore-unmatch -- evals')));
    assert.ok(gitArgs.some((a) => a.includes('commit -q --no-verify --amend')));
    assert.ok(gitArgs.some((a) => a.includes('update-ref refs/remotes/origin/main')));
    assert.ok(gitArgs.some((a) => a.includes('reflog expire --expire=now --all')));
    assert.ok(gitArgs.some((a) => a.includes('gc --prune=now -q')));
    assert.equal(out.effectiveBase, 'e'.repeat(40), 'effective base is the amended commit');
    assert.deepEqual(out.hiddenTestsAtBase, ['src/a.test.ts']);
    const claudeAt = exec.calls.findIndex((c) => c.command === 'claude');
    const gcAt = exec.calls.findIndex((c) => c.command === 'git' && c.args.includes('gc'));
    assert.ok(gcAt < claudeAt, 'answer keys are gone before the agent starts');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask --dry-run: base failToPass fails naming the file, base passToPass green, reference green', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(
      rawTask({ passToPass: ['npx vitest run src/a.test.ts --x', 'npm run type-check:all'] }),
      okChecks
    ).value;
    let phase = 'base';
    const exec = fakeExec((cmd, args) => {
      if (cmd === 'pipe') {
        phase = 'reference';
        return undefined;
      }
      if (cmd === 'bash') {
        const failToPass = task.failToPass.includes(args[1]);
        const fails = phase === 'base' && failToPass;
        return {
          status: fails ? 1 : 0,
          stdout: vitestOut('src/a.test.ts', fails ? { failed: 1 } : {}),
        };
      }
      if (cmd === 'git' && args.includes('show')) return { status: 0, stdout: 'hidden' };
      if (cmd === 'git' && args.includes('cat-file')) return { status: 1, stdout: '' };
      return undefined;
    });
    const out = await runTask(task, ctxFor(exec, tempDir, { dryRun: true }));
    assert.ok(!exec.calls.some((c) => c.command === 'claude'));
    assert.equal(out.status, 'ok', out.reason);
    assert.equal(out.dryRun.ok, true);
    assert.equal(out.dryRun.atBase[0].status, 'fail');
    assert.equal(out.dryRun.passToPassAtBase.length, 2);
    assert.deepEqual(
      out.dryRun.passToPassAtBase.map((r) => r.withHiddenTests),
      [true, false],
      'a passToPass naming a hidden test runs with it at base; the rest without'
    );

    const solvedAlready = fakeExec((cmd) =>
      cmd === 'bash' ? { status: 0, stdout: vitestOut('src/a.test.ts') } : undefined
    );
    const bad = await runTask(task, ctxFor(solvedAlready, tempDir, { dryRun: true }));
    assert.equal(bad.status, 'error');
    assert.match(bad.reason, /passes on base/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('evalExec: a detached grader that times out has its whole process group killed', async () => {
  const started = Date.now();
  const r = await evalExec.run('bash', ['-c', 'sleep 30 & sleep 30; wait'], {
    detached: true,
    timeout: 200,
  });
  assert.ok(Date.now() - started < 8000, 'background child in the group did not hold the pipes');
  assert.match(r.stderr, /timed out after 200 ms/);
});

// ---------------------------------------------------------------- summary

test('taskLeakTerms: PR numbers from title/notes, reference short SHA, leakTerms', () => {
  const task = validateTask(
    rawTask({ title: 'Fix (#1151)', notes: 'From #1151 (fix for #1131).', leakTerms: ['fooBar'] }),
    okChecks
  ).value;
  const terms = taskLeakTerms(task).map((t) => t.term);
  assert.deepEqual(terms.sort(), ['#1131', '#1151', SHA_B.slice(0, 8), 'fooBar'].sort());
});

test('overlayLeakReport tags seen tasks and warns when a test-split task is seen', () => {
  const tasks = [
    validateTask(rawTask({ id: 'seen-test', split: 'test', notes: 'From #1151.' }), okChecks).value,
    validateTask(rawTask({ id: 'unseen', notes: 'From #1999.', referenceCommit: SHA_B }), okChecks)
      .value,
  ];
  const files = [{ path: 'CLAUDE.md', text: 'intro\nLesson from #1151: resolve vars once\n' }];
  const report = overlayLeakReport(tasks, files);
  assert.equal(report['seen-test'].seen, true);
  assert.deepEqual(report['seen-test'].hits, [{ path: 'CLAUDE.md', line: 2, term: '#1151' }]);
  assert.match(report['seen-test'].warning, /held-out/);
  assert.equal(report.unseen.seen, false);
  assert.equal(report.unseen.warning, null);
});

test('summariseBuild reports all vs unseen pass rates', () => {
  const run = (taskId, outcome, seenInHarness) => ({
    taskId,
    split: 'train',
    status: 'ok',
    outcome,
    failToPassFraction: outcome === 'pass' ? 1 : 0,
    seenInHarness,
  });
  const s = summariseBuild([
    run('a', 'pass', true),
    run('a', 'pass', true),
    run('b', 'fail', false),
  ]);
  assert.equal(s.byTask.a.seenInHarness, true);
  assert.equal(s.byTask.b.seenInHarness, false);
  assert.equal(s.totals.scored, 3);
  assert.equal(s.unseen.scored, 1);
  assert.equal(s.unseen.pass1, 0);
  const md = formatBuildMarkdown({
    config: 'x',
    harnessSha: SHA_B,
    dryRun: false,
    runs: [],
    summary: s,
  });
  assert.match(md, /unseen/);
});

test('summariseBuild: pass@1, pass^n, failToPass fraction, regressions, error rate, Wilson CI', () => {
  const r = (taskId, outcome, failToPassFraction, extra = {}) => ({
    taskId,
    split: 'train',
    status: 'ok',
    outcome,
    failToPassFraction,
    passToPassBroken: false,
    agent: { costUsd: 2, minutes: 10 },
    ...extra,
  });
  const s = summariseBuild([
    r('a', 'pass', 1),
    r('a', 'pass', 1),
    r('b', 'pass', 1),
    r('b', 'fail', 0.5, { passToPassBroken: true }),
    r('c', 'fail', 0, { contaminated: true }),
    { taskId: 'c', split: 'test', status: 'error', reason: 'unparseable stream' },
  ]);
  assert.equal(s.byTask.a.pass1, 1);
  assert.equal(s.byTask.a.passHatN, 1);
  assert.equal(s.byTask.b.pass1, 0.5);
  assert.equal(s.byTask.b.passHatN, 0);
  assert.equal(s.byTask.b.meanFailToPassFraction, 0.75);
  assert.equal(s.byTask.b.passToPassBrokenRate, 0.5);
  assert.equal(s.byTask.c.errors, 1);
  assert.equal(s.byTask.c.scored, 1);
  assert.equal(s.byTask.c.contaminated, 1);
  assert.equal(s.byTask.a.meanCostUsd, 2);
  assert.equal(s.byTask.a.meanMinutes, 10);
  assert.equal(s.totals.scored, 5);
  assert.equal(s.totals.passes, 3);
  assert.equal(s.totals.errors, 1);
  assert.equal(s.totals.errorRate, 1 / 6);
  assert.equal(s.totals.pass1, 0.6);
  assert.ok(s.totals.ci.low < 0.6 && s.totals.ci.high > 0.6);
  assert.equal(s.totals.totalCostUsd, 10);
  const md = formatBuildMarkdown({
    config: 'x',
    harnessSha: SHA_B,
    dryRun: false,
    runs: [],
    summary: s,
  });
  assert.match(md, /pass@1/);
  assert.match(md, /\| a \|/);
  assert.match(
    md.split('\n').slice(0, 6).join('\n'),
    /harness errors.*1\/6/i,
    'error rate is up top'
  );
});

test('formatBuildMarkdown escapes backslashes, pipes and newlines in dry-run reasons', () => {
  const md = formatBuildMarkdown({
    config: 'x',
    harnessSha: SHA_B,
    dryRun: true,
    runs: [{ taskId: 't', split: 'train', status: 'error', reason: 'a\\|b|c\nd' }],
  });
  const row = md.split('\n').find((l) => l.startsWith('| t |'));
  assert.equal(row, '| t | train | FAIL | a\\\\\\|b\\|c d |');
});
