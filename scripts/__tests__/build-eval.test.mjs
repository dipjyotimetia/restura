import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyHiddenTests,
  applyReferenceDiff,
  buildAgentArgs,
  buildAgentPrompt,
  buildExec,
  classifyAgentRun,
  dryRunVerdict,
  formatBuildMarkdown,
  gitChecks,
  gradeCommands,
  loadTasks,
  PROMPT_SUFFIX,
  parseBuildArgs,
  redact,
  runCommand,
  runTask,
  summariseBuild,
  TASKS_DIR,
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
    failToPass: ['npx vitest run src/a.test.ts'],
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

test('committed tasks validate against this repo and keep a train/test split', () => {
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

test('runCommand runs through bash -c in the repo and keeps a tail of the output', async () => {
  const exec = fakeExec(() => ({ status: 1, stdout: `${'x'.repeat(5000)}END`, stderr: 'boom' }));
  const r = await runCommand(exec, 'npm test', { cwd: '/r', timeoutMs: 1000 });
  assert.equal(exec.calls[0].command, 'bash');
  assert.deepEqual(exec.calls[0].args, ['-c', 'npm test']);
  assert.equal(exec.calls[0].opts.cwd, '/r');
  assert.equal(exec.calls[0].opts.timeout, 1000);
  assert.equal(r.status, 'fail');
  assert.equal(r.exitCode, 1);
  assert.ok(r.tail.length <= 2000);
  assert.ok(r.tail.includes('boom'));
  const timedOut = await runCommand(
    fakeExec(() => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: 'timed out after' })),
    'x',
    { cwd: '/r', timeoutMs: 1 }
  );
  assert.equal(timedOut.status, 'timeout');
  const ok = await runCommand(
    fakeExec(() => undefined),
    'x',
    { cwd: '/r', timeoutMs: 1 }
  );
  assert.equal(ok.status, 'pass');
});

test('gradeCommands: pass only when every command passes; partial is the fraction', () => {
  const pass = { status: 'pass' };
  const fail = { status: 'fail' };
  assert.deepEqual(gradeCommands({ failToPass: [pass], passToPass: [pass, pass] }), {
    outcome: 'pass',
    partial: 1,
  });
  assert.deepEqual(gradeCommands({ failToPass: [fail], passToPass: [pass, pass, pass] }), {
    outcome: 'fail',
    partial: 0.75,
  });
  assert.deepEqual(gradeCommands({ failToPass: [], passToPass: [] }), {
    outcome: 'fail',
    partial: 0,
  });
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

test('dryRunVerdict: every failToPass must fail on base, everything must pass on the reference', () => {
  const p = { status: 'pass', command: 'p' };
  const f = { status: 'fail', command: 'f' };
  assert.deepEqual(
    dryRunVerdict({ atBase: [f, f], atReference: { failToPass: [p, p], passToPass: [p] } }),
    { ok: true, problems: [] }
  );
  const bad = dryRunVerdict({
    atBase: [p, f],
    atReference: { failToPass: [p, f], passToPass: [f] },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 3);
  assert.ok(bad.problems.some((x) => /passes on base/.test(x)));
});

// ---------------------------------------------------------------- runTask

function runTaskExec({ agentStdout, commandStatus = () => 0, commits = '1' }) {
  return fakeExec((cmd, args) => {
    if (cmd === 'claude') return { status: 0, stdout: agentStdout, stderr: '' };
    if (cmd === 'bash') {
      const status = commandStatus(args[1]);
      return { status, stdout: `ran ${args[1]}`, stderr: '' };
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

test('runTask grades the outcome state: hidden tests added after the agent, all commands pass', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    const exec = runTaskExec({ agentStdout: goodStream });
    const out = await runTask(task, ctxFor(exec, tempDir));
    assert.equal(out.status, 'ok', out.reason);
    assert.equal(out.outcome, 'pass');
    assert.equal(out.partial, 1);
    assert.equal(out.agent.costUsd, 2);
    assert.equal(out.committed, true);
    const order = exec.calls.map((c) => c.command ?? 'pipe');
    const claudeAt = order.indexOf('claude');
    const showAt = exec.calls.findIndex((c) => c.command === 'git' && c.args.includes('show'));
    const firstBash = order.indexOf('bash');
    assert.ok(claudeAt >= 0 && claudeAt < showAt, 'hidden tests are applied after the agent');
    assert.ok(showAt < firstBash, 'graders run after the hidden tests are in place');
    const claudeCall = exec.calls[claudeAt];
    assert.ok(claudeCall.opts.input.endsWith(PROMPT_SUFFIX));
    assert.equal(claudeCall.opts.timeout, 30 * 60 * 1000);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask: failing failToPass → fail with partial credit and per-command tails', async () => {
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
    assert.equal(out.partial, 0.5);
    assert.equal(out.commands.failToPass[0].status, 'fail');
    assert.match(out.commands.failToPass[0].tail, /ran npx vitest/);
    assert.equal(out.committed, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask: a transcript touching the main checkout is contaminated → error, not graded', async () => {
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
    assert.equal(out.status, 'error');
    assert.match(out.reason, /contaminated/);
    assert.ok(!exec.calls.some((c) => c.command === 'bash'), 'no grading for a contaminated run');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildExec: a timeout kills the child and reports it', async () => {
  const started = Date.now();
  const r = await buildExec.run('sleep', ['30'], { timeout: 100 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(r.signal, 'SIGTERM');
  assert.match(r.stderr, /timed out after 100 ms/);
});

test('redact returns the text (harness-eval redactSecrets when it is exported)', () => {
  assert.ok(redact('plain text', {}).includes('plain'));
});

test('classifyAgentRun fails closed; only success and max-turns are graded', () => {
  const ok = (events, extra = {}) => ({ status: 0, stdout: stream(events), stderr: '', ...extra });
  const result = (extra) => ({ type: 'result', subtype: 'success', num_turns: 4, ...extra });
  assert.equal(classifyAgentRun(ok([result()])).graded, true);
  const maxTurns = classifyAgentRun(ok([result({ subtype: 'error_max_turns', is_error: true })]));
  assert.equal(maxTurns.graded, true);
  assert.match(maxTurns.stopped, /max turns/);
  for (const [label, raw] of [
    ['budget', ok([result({ subtype: 'error_max_budget_usd', is_error: true })])],
    ['is_error', ok([result({ is_error: true })])],
    ['error subtype', ok([result({ subtype: 'error_during_execution' })])],
    ['zero turns', ok([result({ num_turns: 0 })])],
    ['non-zero exit', ok([result()], { status: 1 })],
    ['timeout', ok([result()], { status: null, signal: 'SIGTERM' })],
    ['unparseable', { status: 0, stdout: 'not json', stderr: '' }],
  ])
    assert.equal(classifyAgentRun(raw).graded, false, label);
});

test('runTask: crashed or budget-stopped agents are errors (excluded); max turns is graded', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    const crash = await runTask(task, ctxFor(runTaskExec({ agentStdout: '' }), tempDir));
    assert.equal(crash.status, 'error');
    const budget = await runTask(
      task,
      ctxFor(
        runTaskExec({
          agentStdout: stream([
            { type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 50 },
          ]),
        }),
        tempDir
      )
    );
    assert.equal(budget.status, 'error');
    assert.equal(budget.outcome, null);
    const turns = await runTask(
      task,
      ctxFor(
        runTaskExec({
          agentStdout: stream([
            { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 50 },
          ]),
        }),
        tempDir
      )
    );
    assert.equal(turns.status, 'ok');
    assert.match(turns.agentStopped, /max turns/);
    assert.equal(turns.outcome, 'pass');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask strips the answer keys (evals/) from the isolated repo and records hidden tests at base', async () => {
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
    assert.equal(out.effectiveBase, 'e'.repeat(40), 'effective base is the amended commit');
    assert.deepEqual(out.hiddenTestsAtBase, ['src/a.test.ts']);
    const claudeAt = exec.calls.findIndex((c) => c.command === 'claude');
    const amendAt = exec.calls.findIndex((c) => c.command === 'git' && c.args.includes('--amend'));
    assert.ok(amendAt < claudeAt, 'answer keys are gone before the agent starts');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runTask --dry-run: never calls claude; hidden tests must fail on base and pass on the reference', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-eval-test-'));
  try {
    const task = validateTask(rawTask(), okChecks).value;
    let phase = 'base';
    const exec = fakeExec((cmd, args) => {
      if (cmd === 'pipe') {
        phase = 'reference';
        return undefined;
      }
      if (cmd === 'bash') return { status: phase === 'base' ? 1 : 0, stdout: '', stderr: '' };
      if (cmd === 'git' && args.includes('show')) return { status: 0, stdout: 'hidden' };
      if (cmd === 'git' && args.includes('cat-file')) return { status: 1, stdout: '' };
      return undefined;
    });
    const out = await runTask(task, ctxFor(exec, tempDir, { dryRun: true }));
    assert.ok(!exec.calls.some((c) => c.command === 'claude'));
    assert.equal(out.status, 'ok', out.reason);
    assert.equal(out.dryRun.ok, true);
    assert.equal(out.dryRun.atBase[0].status, 'fail');
    // passToPass is not run on base (hidden tests may not even compile there).
    assert.equal(out.dryRun.atBase.length, 1);

    phase = 'base';
    const solvedAlready = fakeExec((cmd) => (cmd === 'bash' ? { status: 0 } : undefined));
    const bad = await runTask(task, ctxFor(solvedAlready, tempDir, { dryRun: true }));
    assert.equal(bad.status, 'error');
    assert.match(bad.reason, /passes on base/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- summary

test('summariseBuild: pass@1, pass^n, partial, cost, minutes; errors excluded; Wilson CI', () => {
  const r = (taskId, outcome, partial, extra = {}) => ({
    taskId,
    split: 'train',
    status: 'ok',
    outcome,
    partial,
    agent: { costUsd: 2, minutes: 10 },
    ...extra,
  });
  const s = summariseBuild([
    r('a', 'pass', 1),
    r('a', 'pass', 1),
    r('b', 'pass', 1),
    r('b', 'fail', 0.5),
    r('c', 'fail', 0),
    { taskId: 'c', split: 'test', status: 'error', reason: 'contaminated' },
  ]);
  assert.equal(s.byTask.a.pass1, 1);
  assert.equal(s.byTask.a.passHatN, 1);
  assert.equal(s.byTask.b.pass1, 0.5);
  assert.equal(s.byTask.b.passHatN, 0);
  assert.equal(s.byTask.b.meanPartial, 0.75);
  assert.equal(s.byTask.c.errors, 1);
  assert.equal(s.byTask.c.scored, 1);
  assert.equal(s.byTask.a.meanCostUsd, 2);
  assert.equal(s.byTask.a.meanMinutes, 10);
  assert.equal(s.totals.scored, 5);
  assert.equal(s.totals.passes, 3);
  assert.equal(s.totals.errors, 1);
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
});
