import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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
