import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skill-usage-report.mjs');

function fixture({ skillLog, subagentLog, stopLog } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'restura-skill-report-'));
  const metrics = join(root, '.claude', 'metrics');
  mkdirSync(metrics, { recursive: true });
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(root, '.claude', 'skills', name), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  // A symlinked (vendored) skill must count as defined too.
  mkdirSync(join(root, '.agents', 'skills', 'gamma'), { recursive: true });
  writeFileSync(join(root, '.agents', 'skills', 'gamma', 'SKILL.md'), '---\nname: gamma\n---\n');
  symlinkSync('../../.agents/skills/gamma', join(root, '.claude', 'skills', 'gamma'));
  if (skillLog) writeFileSync(join(metrics, 'skill-usage.log'), skillLog);
  if (subagentLog) writeFileSync(join(metrics, 'subagent.log'), subagentLog);
  if (stopLog) writeFileSync(join(metrics, 'stop-outcomes.log'), stopLog);
  return root;
}

function run(root, args = ['--json']) {
  const res = spawnSync('node', [script, ...args], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

const T = '2026-10-25T10:00:00.000Z';

test('no metrics at all: every section reports no-data, symlinked skills are defined', () => {
  const out = JSON.parse(run(fixture()));
  assert.equal(out.status, 'no-data');
  assert.deepEqual([...out.neverFired].sort(), ['alpha', 'beta', 'gamma']);
  assert.equal(out.subagents.status, 'no-data');
  assert.equal(out.stopOutcomes.status, 'no-data');
});

test('subagent.log: counts by agent type, distinct sessions and mean per session', () => {
  const subagentLog = [
    `${T}\ts1\tExplore\ta1\t-\t-`,
    `${T}\ts1\tExplore\ta2\t-\t-`,
    `${T}\ts1\trestura-parity-checker\ta3\t-\t-`,
    `${T}\ts2\tExplore\ta4\t-\t-`,
    `${T}\ts2\t-\ta5\t-\t-`,
    'garbage',
  ].join('\n');
  const out = JSON.parse(run(fixture({ subagentLog })));
  const s = out.subagents;
  assert.equal(s.status, 'ok');
  assert.equal(s.total, 5);
  assert.equal(s.sessions, 2);
  assert.equal(s.meanPerSession, 2.5);
  assert.equal(s.malformedLines, 1);
  assert.deepEqual(
    s.byType.map((t) => [t.type, t.total, t.sessions]),
    [
      ['Explore', 3, 2],
      ['(unknown)', 1, 1],
      ['restura-parity-checker', 1, 1],
    ]
  );
  assert.deepEqual(s.perSession, [3, 2]);
  assert.ok(!JSON.stringify(out).includes('s1'), 'session ids are never printed');
});

test('stop-outcomes.log: fire rate per check and blocked vs allowed', () => {
  const stopLog = [
    `${T}\ts1\ttype-check,lint\tblocked`,
    `${T}\ts1\t-\tallowed`,
    `${T}\ts2\ttype-check\tblocked`,
    `${T}\ts2\t-\tallowed`,
    `${T}\ts2\t-\treentrant`,
    `${T}\ts3\t-\treentrant`,
  ].join('\n');
  const out = JSON.parse(run(fixture({ stopLog })));
  const st = out.stopOutcomes;
  assert.equal(st.status, 'ok');
  assert.equal(st.total, 4);
  assert.equal(st.blocked, 2);
  assert.equal(st.allowed, 2);
  assert.equal(st.blockRate, 0.5);
  assert.equal(st.reentrant, 2, 're-entrant stops are counted separately, not in rates');
  assert.deepEqual(
    st.checks.map((c) => [c.name, c.fired, c.fireRate]),
    [
      ['type-check', 2, 0.5],
      ['lint', 1, 0.25],
    ]
  );
});

test('human-readable output includes all three sections', () => {
  const out = run(
    fixture({
      skillLog: `${T}\talpha\ts1\n`,
      subagentLog: `${T}\ts1\tExplore\ta1\t-\t-\n`,
      stopLog: `${T}\ts1\tlint\tblocked\n`,
    }),
    []
  );
  assert.match(out, /Skill usage/);
  assert.match(out, /Subagents/);
  assert.match(out, /Explore/);
  assert.match(out, /Stop-hook outcomes/);
  assert.match(out, /lint/);
});

test('--snapshot writes a counts-only cumulative summary under evals/metrics; --merged sums labels', () => {
  const root = fixture({
    skillLog: `${T}\talpha\ts1\n${T}\talpha\ts2\n`,
    subagentLog: `${T}\ts1\tExplore\ta1\t-\t-\n`,
    stopLog: `${T}\ts1\tlint\tblocked\n`,
  });
  const out = run(root, ['--snapshot', '--label', 'Laptop One']);
  assert.match(out, /evals\/metrics\/\d{4}-\d{2}-\d{2}--laptop-one\.json/);
  const dir = join(root, 'evals', 'metrics');
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const snap = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(snap.kind, 'metrics-snapshot');
  assert.equal(snap.label, 'laptop-one');
  assert.equal(snap.skills[0].total, 2);
  assert.doesNotMatch(JSON.stringify(snap), /"s1"|"s2"/, 'session ids never leave the machine');

  // A second machine's snapshot (older and newer for the same label: only the newest counts).
  writeFileSync(
    join(dir, '2026-01-01--ci.json'),
    JSON.stringify({
      kind: 'metrics-snapshot',
      label: 'ci',
      writtenAt: '2026-01-01T00:00:00Z',
      status: 'ok',
      totals: { sessions: 9 },
      skills: [{ name: 'alpha', total: 99, distinctSessions: 9, firstSeen: T, lastSeen: T }],
      subagents: { status: 'no-data' },
      stopOutcomes: { status: 'no-data' },
    })
  );
  writeFileSync(
    join(dir, '2026-02-01--ci.json'),
    JSON.stringify({
      kind: 'metrics-snapshot',
      label: 'ci',
      writtenAt: '2026-02-01T00:00:00Z',
      status: 'ok',
      totals: { sessions: 3, invocations: 4 },
      skills: [
        {
          name: 'alpha',
          total: 3,
          distinctSessions: 3,
          firstSeen: '2026-01-30T00:00:00.000Z',
          lastSeen: T,
        },
        { name: 'beta', total: 1, distinctSessions: 1, firstSeen: T, lastSeen: T },
      ],
      subagents: {
        status: 'ok',
        total: 2,
        sessions: 1,
        byType: [{ type: 'Explore', total: 2, sessions: 1 }],
        perSession: [2],
      },
      stopOutcomes: {
        status: 'ok',
        total: 1,
        blocked: 0,
        allowed: 1,
        reentrant: 0,
        checks: [{ name: 'lint', fired: 1, fireRate: 1 }],
      },
    })
  );
  const mergedOut = JSON.parse(run(root, ['--json', '--merged', '--label', 'laptop-one']));
  assert.deepEqual(mergedOut.sources, ['laptop-one', 'ci']);
  const alpha = mergedOut.skills.find((s) => s.name === 'alpha');
  assert.equal(alpha.total, 5, 'local 2 + latest ci 3, never the superseded 99');
  assert.equal(alpha.distinctSessions, 5);
  assert.equal(alpha.firstSeen, '2026-01-30T00:00:00.000Z');
  assert.deepEqual(mergedOut.neverFired, ['gamma']);
  assert.equal(mergedOut.subagents.total, 3);
  assert.equal(mergedOut.stopOutcomes.total, 2);
  assert.equal(mergedOut.stopOutcomes.checks[0].fired, 2);
  // Without --merged the local report is unchanged.
  const local = JSON.parse(run(root, ['--json', '--label', 'laptop-one']));
  assert.equal(local.skills.find((s) => s.name === 'alpha').total, 2);
  assert.equal(local.sources, undefined);
});
