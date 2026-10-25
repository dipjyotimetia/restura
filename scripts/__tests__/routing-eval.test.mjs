import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildRoutingClaudeArgs,
  classifyRoutingRun,
  createSnapshot,
  createTrackedExec,
  formatRoutingMarkdown,
  gradeRoutingRun,
  loadRoutingCases,
  makeSignalHandler,
  parseRoutingArgs,
  runRoutingEval,
  SNAPSHOT_EXCLUDES,
  summariseRouting,
  validateRoutingCases,
} from '../routing-eval.mjs';

const KNOWN = {
  skills: new Set(['ship-check', 'batch-ship', 'restura-feature-dev', 'verify-ui-change']),
  agents: new Set(['restura-security-auditor']),
};

const positive = {
  id: 'ship',
  split: 'train',
  prompt: 'review my branches',
  expectSkills: ['ship-check'],
  forbidSkills: ['batch-ship'],
};
const negative = {
  id: 'typo',
  split: 'test',
  prompt: 'fix a typo',
  forbidSkills: ['batch-ship'],
  forbidAgents: ['restura-security-auditor'],
};

/** A stream-json transcript with the given Skill / Task calls and a result event. */
function stream({ skills = [], agents = [], result = {} }) {
  const lines = [{ type: 'system', subtype: 'init' }];
  const content = [
    ...skills.map((skill) => ({ type: 'tool_use', name: 'Skill', input: { skill } })),
    ...agents.map((a) => ({ type: 'tool_use', name: 'Task', input: { subagent_type: a } })),
    { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
  ];
  lines.push({ type: 'assistant', message: { content } });
  lines.push({
    type: 'result',
    subtype: 'success',
    result: 'done',
    total_cost_usd: 0.1,
    duration_ms: 1000,
    num_turns: 2,
    ...result,
  });
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

// ---------------------------------------------------------------- arguments

test('parseRoutingArgs defaults and options', () => {
  const d = parseRoutingArgs([]);
  assert.equal(d.runs, 2);
  assert.equal(d.maxBudgetUsd, 1);
  assert.equal(d.split, 'all');
  assert.equal(d.dryRun, false);
  assert.equal(d.ref, 'HEAD');
  const o = parseRoutingArgs([
    '--runs',
    '3',
    '--case',
    'a',
    '--case',
    'b',
    '--split',
    'test',
    '--dry-run',
    '--max-budget-usd',
    '0.5',
    '--config',
    'ci-1',
  ]);
  assert.deepEqual(o.caseIds, ['a', 'b']);
  assert.equal(o.runs, 3);
  assert.equal(o.split, 'test');
  assert.equal(o.dryRun, true);
  assert.equal(o.maxBudgetUsd, 0.5);
  assert.equal(o.config, 'ci-1');
  assert.throws(() => parseRoutingArgs(['--runs', '0']), /runs/);
  assert.throws(() => parseRoutingArgs(['--split', 'dev']), /split/);
  assert.throws(() => parseRoutingArgs(['--max-budget-usd', '-1']), /budget/);
  assert.throws(() => parseRoutingArgs(['--nope']), /unknown/);
});

// ---------------------------------------------------------------- validation

test('validateRoutingCases accepts positive and negative cases', () => {
  const res = validateRoutingCases({ cases: [positive, negative] }, KNOWN);
  assert.deepEqual(res.errors, []);
  assert.equal(res.cases.length, 2);
  assert.equal(res.cases[0].kind, 'positive');
  assert.equal(res.cases[1].kind, 'negative');
  assert.deepEqual(res.cases[1].expectSkills, []);
});

test('validateRoutingCases reports every problem', () => {
  const res = validateRoutingCases(
    {
      cases: [
        { ...positive, id: 'Bad Id' },
        { ...positive, split: undefined },
        { ...positive, id: 'empty', prompt: ' ' },
        { id: 'nothing', split: 'train', prompt: 'p' },
        { ...positive, id: 'unknown-skill', expectSkills: ['no-such-skill'] },
        { ...negative, id: 'unknown-agent', forbidAgents: ['ghost'] },
        { ...positive, id: 'both', forbidSkills: ['ship-check'] },
        { ...positive, id: 'not-list', expectSkills: 'ship-check' },
        positive,
        positive,
      ],
    },
    KNOWN
  );
  const text = res.errors.join('\n');
  for (const re of [
    /kebab/,
    /split/,
    /prompt/,
    /nothing: .*at least one/,
    /no-such-skill/,
    /ghost/,
    /both: .*ship-check.*expected and forbidden/,
    /not-list: .*expectSkills/,
    /duplicate id ship/,
  ])
    assert.match(text, re);
  assert.match(validateRoutingCases({}, KNOWN).errors.join('\n'), /cases/);
});

test('the committed routing cases are valid, balanced and ~30% test', () => {
  const cases = loadRoutingCases();
  assert.ok(cases.length >= 18, `${cases.length} cases`);
  const negatives = cases.filter((c) => c.kind === 'negative').length;
  assert.ok(negatives >= cases.length / 3, `${negatives} negative of ${cases.length}`);
  const test_ = cases.filter((c) => c.split === 'test');
  assert.ok(test_.length / cases.length >= 0.25 && test_.length / cases.length <= 0.35);
  assert.ok(test_.some((c) => c.kind === 'negative') && test_.some((c) => c.kind === 'positive'));
  for (const c of cases)
    assert.doesNotMatch(c.prompt, new RegExp(`\\b(${[...c.expectSkills].join('|') || '$^'})\\b`));
  assert.deepEqual(
    loadRoutingCases({ split: 'test' }).map((c) => c.id),
    test_.map((c) => c.id)
  );
  assert.throws(() => loadRoutingCases({ caseIds: ['no-such-case'] }), /no-such-case/);
});

// ---------------------------------------------------------------- grading

test('gradeRoutingRun: positive passes on any expected skill and no forbidden one', () => {
  assert.equal(gradeRoutingRun(positive, { skills: ['ship-check'], agents: [] }).pass, true);
  const missed = gradeRoutingRun(positive, { skills: [], agents: [] });
  assert.equal(missed.pass, false);
  assert.deepEqual(missed.expectedHit, []);
  const forbidden = gradeRoutingRun(positive, { skills: ['ship-check', 'batch-ship'], agents: [] });
  assert.equal(forbidden.pass, false);
  assert.deepEqual(forbidden.forbiddenHit, ['skill:batch-ship']);
  // A leading slash still counts; a plugin skill of the same bare name does not.
  assert.equal(gradeRoutingRun(positive, { skills: ['/ship-check'], agents: [] }).pass, true);
  assert.equal(gradeRoutingRun(positive, { skills: ['other:ship-check'], agents: [] }).pass, false);
});

test('gradeRoutingRun: expected agents count for the any-of', () => {
  const c = {
    ...positive,
    expectSkills: ['ship-check'],
    expectAgents: ['restura-security-auditor'],
  };
  assert.equal(gradeRoutingRun(c, { skills: [], agents: ['restura-security-auditor'] }).pass, true);
});

test('gradeRoutingRun: negative passes unless a forbidden skill or agent ran', () => {
  assert.equal(gradeRoutingRun(negative, { skills: [], agents: [] }).pass, true);
  assert.equal(gradeRoutingRun(negative, { skills: ['ship-check'], agents: [] }).pass, true);
  assert.equal(
    gradeRoutingRun(negative, { skills: [], agents: ['restura-security-auditor'] }).pass,
    false
  );
});

test('classifyRoutingRun parses a stream and keeps max-turns runs (routing already happened)', () => {
  const ok = classifyRoutingRun({ status: 0, stdout: stream({ skills: ['ship-check'] }) });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.parsed.toolStats.skills, ['ship-check']);
  const maxTurns = classifyRoutingRun({
    status: 1,
    stdout: stream({
      agents: ['restura-security-auditor'],
      result: { subtype: 'error_max_turns' },
    }),
  });
  assert.equal(maxTurns.status, 'ok');
  assert.deepEqual(maxTurns.parsed.toolStats.agents, ['restura-security-auditor']);
});

test('classifyRoutingRun flags harness failures as errors, not misses', () => {
  assert.equal(classifyRoutingRun({ status: 0, stdout: 'garbage' }).status, 'error');
  assert.equal(classifyRoutingRun({ status: null, signal: 'SIGTERM', stdout: '' }).status, 'error');
  const budget = classifyRoutingRun({
    status: 1,
    stdout: stream({ result: { subtype: 'error_max_budget_usd' } }),
  });
  assert.equal(budget.status, 'error');
  assert.match(budget.reason, /budget/);
  const denied = classifyRoutingRun({
    status: 0,
    stdout: stream({ result: { permission_denials: [{ tool_name: 'Skill' }] } }),
  });
  assert.equal(denied.status, 'error');
  // Edit/Write/Bash are deliberately disallowed; denials of those are expected.
  const editDenied = classifyRoutingRun({
    status: 0,
    stdout: stream({ result: { permission_denials: [{ tool_name: 'Edit' }] } }),
  });
  assert.equal(editDenied.status, 'ok');
});

test('buildRoutingClaudeArgs is read-only, turn- and budget-capped', () => {
  const args = buildRoutingClaudeArgs({ maxBudgetUsd: 1, model: 'sonnet' });
  const joined = args.join(' ');
  for (const part of [
    '-p',
    '--output-format stream-json',
    '--verbose',
    '--max-turns 3',
    '--permission-mode dontAsk',
    '--max-budget-usd 1',
    '--model sonnet',
  ])
    assert.ok(joined.includes(part), part);
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed.slice(0, 5), ['Read', 'Grep', 'Glob', 'Skill', 'Task']);
  const disallowed = args.slice(args.indexOf('--disallowedTools') + 1);
  for (const tool of ['Edit', 'Write', 'Bash']) assert.ok(disallowed.includes(tool), tool);
});

// ---------------------------------------------------------------- summary

test('summariseRouting: per-case pass@1 / pass^n and per-skill precision/recall', () => {
  const cases = validateRoutingCases({ cases: [positive, negative] }, KNOWN).cases;
  const run = (c, skills, agents = [], status = 'ok') => ({
    caseId: c.id,
    status,
    toolStats: { toolCalls: 1, skills, agents },
    grade: status === 'ok' ? gradeRoutingRun(c, { skills, agents }) : null,
    costUsd: 0.1,
  });
  const runs = [
    run(cases[0], ['ship-check']),
    run(cases[0], []),
    run(cases[1], ['ship-check']),
    run(cases[1], [], [], 'error'),
  ];
  const s = summariseRouting(cases, runs);
  const ship = s.cases.find((c) => c.id === 'ship');
  assert.equal(ship.scored, 2);
  assert.equal(ship.passes, 1);
  assert.equal(ship.passAt1, 0.5);
  assert.equal(ship.passHatN, 0);
  const typo = s.cases.find((c) => c.id === 'typo');
  assert.equal(typo.scored, 1);
  assert.equal(typo.errors, 1);
  assert.equal(typo.passHatN, 1);
  // ship-check: expected in 2 scored runs, invoked in 2 (1 TP, 1 FP on the negative case, 1 FN).
  const metric = s.names.find((n) => n.name === 'skill:ship-check');
  assert.deepEqual({ tp: metric.tp, fp: metric.fp, fn: metric.fn }, { tp: 1, fp: 1, fn: 1 });
  assert.equal(metric.precision, 0.5);
  assert.equal(metric.recall, 0.5);
  assert.equal(s.totals.scored, 3);
  assert.equal(s.totals.passes, 2);
  assert.equal(s.totals.errors, 1);
  assert.ok(s.totals.passRateCi);
  const md = formatRoutingMarkdown({ config: 'x', runsPerCase: 2, summary: s, harnessSha: 'abc' });
  assert.match(md, /\| ship \|/);
  assert.match(md, /pass\^2/);
  assert.match(md, /skill:ship-check/);
});

// ---------------------------------------------------------------- review round 1

test('classifyRoutingRun fails closed on is_error, a non-zero exit, or a run that never acted', () => {
  // Auth/API failure: subtype success, is_error true, exit 1.
  const authFail = classifyRoutingRun({
    status: 1,
    stdout: stream({ result: { subtype: 'success', is_error: true, num_turns: 1 } }),
  });
  assert.equal(authFail.status, 'error');
  // is_error with exit 0 is still an error.
  assert.equal(
    classifyRoutingRun({ status: 0, stdout: stream({ result: { is_error: true } }) }).status,
    'error'
  );
  // A non-zero exit is not excused by subtype success.
  assert.equal(classifyRoutingRun({ status: 1, stdout: stream({}) }).status, 'error');
  // Max turns may report is_error and exit non-zero: routing already happened.
  assert.equal(
    classifyRoutingRun({
      status: 1,
      stdout: stream({ result: { subtype: 'error_max_turns', is_error: true } }),
    }).status,
    'ok'
  );
  // Zero turns, or no assistant event at all.
  assert.equal(
    classifyRoutingRun({ status: 0, stdout: stream({ result: { num_turns: 0 } }) }).status,
    'error'
  );
  const noAssistant = [
    { type: 'system', subtype: 'init' },
    { type: 'result', subtype: 'success', result: '', num_turns: 1 },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
  assert.equal(classifyRoutingRun({ status: 0, stdout: noAssistant }).status, 'error');
});

test('createSnapshot excludes the answer key (evals/) and metrics from the snapshot', async () => {
  const calls = [];
  const exec = {
    run(command, args) {
      calls.push([command, ...args]);
      if (command === 'git' && args.includes('rev-parse'))
        return { status: 0, stdout: `${'d'.repeat(40)}\n`, stderr: '' };
      if (command === 'tar') {
        // Simulate an archive that still carried the excluded paths.
        const dir = args[args.indexOf('-C') + 1];
        for (const rel of ['evals/routing/cases.yaml', '.claude/metrics/x.json', 'CLAUDE.md']) {
          fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), 'x');
        }
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-snap-test-'));
  try {
    const snap = await createSnapshot(exec, 'HEAD', tmp);
    const archive = calls.find((c) => c[0] === 'git' && c.includes('archive'));
    assert.ok(archive.includes(':(exclude)evals'), archive.join(' '));
    assert.ok(archive.includes(':(exclude).claude/metrics'), archive.join(' '));
    assert.equal(fs.existsSync(path.join(snap.dir, 'evals')), false);
    assert.equal(fs.existsSync(path.join(snap.dir, '.claude/metrics')), false);
    assert.equal(fs.existsSync(path.join(snap.dir, 'CLAUDE.md')), true);
    assert.deepEqual([...SNAPSHOT_EXCLUDES].sort(), ['.claude/metrics', 'evals']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the signal handler kills the live claude child, cleans up and exits 130 / 143', () => {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    const events = [];
    const handler = makeSignalHandler({
      exec: { kill: (s) => events.push(`kill:${s}`) },
      cleanup: () => events.push('cleanup'),
      exit: (c) => events.push(`exit:${c}`),
    });
    handler(signal);
    assert.deepEqual(events, ['kill:SIGTERM', 'cleanup', `exit:${code}`]);
  }
});

test('createTrackedExec tracks and kills the running child', async () => {
  const exec = createTrackedExec();
  const pending = exec.run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exec.kill('SIGTERM'), true);
  const res = await pending;
  assert.equal(res.signal, 'SIGTERM');
  assert.equal(exec.kill('SIGTERM'), false);
});

test('runRoutingEval redacts secrets from the injected env before anything reaches disk', async () => {
  const token = 'sk-ant-oat01-FAKE-routing-eval-token-0123456789';
  const env = { CLAUDE_CODE_OAUTH_TOKEN: token, PATH: '/usr/bin' };
  const exec = {
    run(command, args) {
      if (command === 'git' && args.includes('rev-parse'))
        return { status: 0, stdout: `${'e'.repeat(40)}\n`, stderr: '' };
      if (command === 'claude') {
        const leaky = [
          { type: 'system', subtype: 'init', env: `CLAUDE_CODE_OAUTH_TOKEN=${token}` },
          {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: `the token is ${token}` },
                { type: 'tool_use', name: 'Read', input: { file_path: `/tmp/${token}` } },
              ],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            result: `done ${token}`,
            num_turns: 1,
            total_cost_usd: 0.01,
          },
        ];
        return {
          status: 0,
          stdout: leaky.map((l) => JSON.stringify(l)).join('\n'),
          stderr: `warning ${token}`,
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    kill: () => false,
  };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-redact-test-'));
  const origWrite = process.stdout.write;
  let printed = '';
  process.stdout.write = (chunk) => {
    printed += String(chunk);
    return true;
  };
  try {
    const options = parseRoutingArgs([
      '--case',
      'typo-fix-not-batch',
      '--runs',
      '1',
      '--out',
      out,
      '--config',
      'redact',
    ]);
    const { failed } = await runRoutingEval(options, exec, { env });
    assert.equal(failed, false);
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(out);
    assert.ok(
      files.some((f) => f.endsWith('.jsonl')),
      'a transcript was written'
    );
    assert.ok(files.some((f) => f.endsWith('.json')) && files.some((f) => f.endsWith('.md')));
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes(token), `token leaked into ${file}`);
    }
    const transcript = fs.readFileSync(
      files.find((f) => f.endsWith('.jsonl')),
      'utf8'
    );
    assert.match(transcript, /\[REDACTED:CLAUDE_CODE_OAUTH_TOKEN\]/);
    assert.ok(!printed.includes(token), 'token leaked to stdout');
  } finally {
    process.stdout.write = origWrite;
    fs.rmSync(out, { recursive: true, force: true });
  }
});
