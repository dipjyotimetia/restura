#!/usr/bin/env node
/**
 * Aggregate the agent-harness metrics in .claude/metrics/ into one report.
 *
 * Three hooks append machine-local, git-ignored TSV logs:
 *   - skill-usage.log    (PreToolUse(Skill), .claude/hooks/log-skill-usage.mjs)
 *       `<ISO ts>\t<skill name>\t<session id>`
 *   - subagent.log       (SubagentStop, .claude/hooks/log-subagent.mjs)
 *       `<ISO ts>\t<session id>\t<agent type>\t<agent id>\t<duration ms>\t<tokens>`
 *   - stop-outcomes.log  (Stop, .claude/hooks/stop-checks.mjs)
 *       `<ISO ts>\t<session id>\t<fired checks, comma-joined | ->\t<blocked|allowed>`
 *
 * This script is the *analysis* half of the self-improvement loop described in
 * Anthropic's "Lessons from building Claude Code: how we use skills" — surfacing
 * skills that over-trigger (high invocations-per-session) or under-trigger
 * (never fired), how delegation is actually used (subagents by type), and how
 * noisy the Stop hook is (fire rate per check). The `/skill-report` skill
 * consumes the `--json` output and proposes the actual edits.
 *
 * Pure-Node ESM (no deps). Advisory tool a human runs, NOT a determinism gate:
 * there is no `--check` mode. Every log is optional; a missing file yields a
 * `no-data` section rather than an error.
 *
 * Privacy: session ids are used only to count distinct sessions, never printed.
 *
 * The logs are per clone, so one machine's report never sees another machine's
 * (or a cloud session's) usage. `--snapshot` writes this machine's cumulative
 * summary (counts only, no ids) to evals/metrics/<date>--<label>.json, which IS
 * committed; `--merged` adds the latest snapshot of every other label to the
 * local report. See docs/agents/delivery.md "Measurement".
 *
 * Usage:
 *   node scripts/skill-usage-report.mjs                      # human-readable tables
 *   node scripts/skill-usage-report.mjs --json               # machine JSON for /skill-report
 *   node scripts/skill-usage-report.mjs --snapshot [--label x]   # write evals/metrics/<date>--<x>.json
 *   node scripts/skill-usage-report.mjs --json --merged      # local + committed snapshots
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
// Agree with the hooks' path resolution: they honour CLAUDE_PROJECT_DIR too.
const root = process.env.CLAUDE_PROJECT_DIR || repoRoot;
const metricsDir = path.join(root, '.claude', 'metrics');
const logPath = path.join(metricsDir, 'skill-usage.log');
const skillsDir = path.join(root, '.claude', 'skills');
const snapshotsDir = path.join(root, 'evals', 'metrics');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const asSnapshot = argv.includes('--snapshot');
const merged = argv.includes('--merged');
const labelIdx = argv.indexOf('--label');
const label = sanitizeLabel(labelIdx !== -1 ? argv[labelIdx + 1] : os.hostname());

/** A snapshot label is a file-name-safe token (host name or CI name). */
export function sanitizeLabel(value) {
  const s = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'local';
}

const round2 = (n) => Math.round(n * 100) / 100;

// Enumerate the skills that actually exist, by reading the `name:` frontmatter
// of each .claude/skills/*/SKILL.md (falling back to the directory name).
// statSync follows symlinks, so vendored skills linked from .agents/skills
// count — Dirent.isDirectory() would silently drop them.
function definedSkills() {
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir)
    .map((name) => {
      const md = path.join(skillsDir, name, 'SKILL.md');
      if (!fs.existsSync(md)) return null;
      const fm = fs.readFileSync(md, 'utf8').split('---')[1] ?? '';
      const m = fm.match(/^name:\s*(.+)$/m);
      return m ? m[1].trim() : name;
    })
    .filter(Boolean);
}

/** Read a TSV metrics log; null when absent. Lines without a valid ISO ts are malformed. */
function readLog(name) {
  const p = path.join(metricsDir, name);
  if (!fs.existsSync(p)) return null;
  const rows = [];
  let malformed = 0;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const cols = line.split('\t');
    if (!cols[0] || Number.isNaN(Date.parse(cols[0])) || cols.length < 2) {
      malformed++;
      continue;
    }
    rows.push(cols);
  }
  return { rows, malformed };
}

const defined = new Set(definedSkills());

// --- skills ---------------------------------------------------------------
function skillSection() {
  const log = readLog('skill-usage.log');
  if (!log) return { status: 'no-data', skills: [], neverFired: [...defined], ghosts: [] };
  const agg = new Map();
  const allSessions = new Set();
  let malformed = log.malformed;
  for (const [ts, skill, session = '-'] of log.rows) {
    if (!skill) {
      malformed++;
      continue;
    }
    allSessions.add(session);
    let a = agg.get(skill);
    if (!a) {
      a = { total: 0, sessions: new Set(), first: ts, last: ts };
      agg.set(skill, a);
    }
    a.total++;
    a.sessions.add(session);
    if (ts < a.first) a.first = ts; // ISO-8601 strings compare correctly
    if (ts > a.last) a.last = ts;
  }
  const skills = [...agg.entries()]
    .map(([name, a]) => ({
      name,
      total: a.total,
      distinctSessions: a.sessions.size,
      invocationsPerSession: round2(a.total / a.sessions.size),
      firstSeen: a.first,
      lastSeen: a.last,
      defined: defined.has(name),
    }))
    .sort((x, y) => y.total - x.total);
  return {
    status: 'ok',
    totals: {
      invocations: skills.reduce((n, s) => n + s.total, 0),
      sessions: allSessions.size,
      definedSkills: defined.size,
      loggedSkills: agg.size,
      malformedLines: malformed,
    },
    skills,
    neverFired: [...defined].filter((n) => !agg.has(n)),
    ghosts: skills.filter((s) => !s.defined).map((s) => ({ name: s.name, total: s.total })),
  };
}

// --- subagents ------------------------------------------------------------
function subagentSection() {
  const log = readLog('subagent.log');
  if (!log) return { status: 'no-data' };
  const byType = new Map();
  const perSession = new Map();
  for (const [, session = '-', rawType = '-'] of log.rows) {
    const type = rawType && rawType !== '-' ? rawType : '(unknown)';
    let t = byType.get(type);
    if (!t) {
      t = { total: 0, sessions: new Set() };
      byType.set(type, t);
    }
    t.total++;
    t.sessions.add(session);
    perSession.set(session, (perSession.get(session) ?? 0) + 1);
  }
  const total = log.rows.length;
  return {
    status: total ? 'ok' : 'no-data',
    total,
    sessions: perSession.size,
    meanPerSession: perSession.size ? round2(total / perSession.size) : 0,
    malformedLines: log.malformed,
    byType: [...byType.entries()]
      .map(([type, t]) => ({ type, total: t.total, sessions: t.sessions.size }))
      .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type)),
    // Anonymised: subagent count per session, largest first (never the ids).
    perSession: [...perSession.values()].sort((a, b) => b - a),
  };
}

// --- stop outcomes --------------------------------------------------------
function stopSection() {
  const log = readLog('stop-outcomes.log');
  if (!log) return { status: 'no-data' };
  const fired = new Map();
  let blocked = 0;
  let allowed = 0;
  // stop_hook_active stops: the hook deliberately ran no checks, so counting
  // them would dilute every fire/block rate. Reported separately.
  let reentrant = 0;
  for (const [, , checks = '-', outcome = ''] of log.rows) {
    if (outcome === 'reentrant') {
      reentrant++;
      continue;
    }
    if (outcome === 'blocked') blocked++;
    else allowed++;
    if (checks && checks !== '-') {
      for (const name of checks.split(',').filter(Boolean)) {
        fired.set(name, (fired.get(name) ?? 0) + 1);
      }
    }
  }
  const total = blocked + allowed;
  return {
    status: total || reentrant ? 'ok' : 'no-data',
    total,
    blocked,
    allowed,
    reentrant,
    blockRate: total ? round2(blocked / total) : 0,
    malformedLines: log.malformed,
    checks: [...fired.entries()]
      .map(([name, n]) => ({ name, fired: n, fireRate: round2(n / total) }))
      .sort((a, b) => b.fired - a.fired || a.name.localeCompare(b.name)),
  };
}

// --- snapshots: cumulative per-label summaries committed under evals/metrics ---
/**
 * Latest snapshot per label (a snapshot is cumulative for its machine, so newer supersedes older).
 * @param {string} dir
 * @param {{ exclude?: string }} [options]
 */
export function latestSnapshots(dir, { exclude } = {}) {
  if (!fs.existsSync(dir)) return [];
  const byLabel = new Map();
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    let snap;
    try {
      snap = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (snap?.kind !== 'metrics-snapshot' || typeof snap.label !== 'string') continue;
    if (snap.label === exclude) continue;
    const prev = byLabel.get(snap.label);
    if (!prev || String(snap.writtenAt) > String(prev.writtenAt)) byLabel.set(snap.label, snap);
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const sum = (xs) => xs.reduce((n, x) => n + (Number(x) || 0), 0);

/** Add the skill/subagent/stop sections of `snapshots` to `local`. Counts and timestamps only. */
export function mergeReports(local, snapshots) {
  const reports = [local, ...snapshots];
  // skills
  const skills = new Map();
  for (const r of reports) {
    for (const s of r.skills ?? []) {
      const cur = skills.get(s.name) ?? {
        name: s.name,
        total: 0,
        distinctSessions: 0,
        firstSeen: s.firstSeen,
        lastSeen: s.lastSeen,
        defined: defined.has(s.name),
      };
      cur.total += s.total;
      cur.distinctSessions += s.distinctSessions;
      if (s.firstSeen < cur.firstSeen) cur.firstSeen = s.firstSeen;
      if (s.lastSeen > cur.lastSeen) cur.lastSeen = s.lastSeen;
      skills.set(s.name, cur);
    }
  }
  const skillList = [...skills.values()]
    .map((s) => ({
      ...s,
      invocationsPerSession: s.distinctSessions ? round2(s.total / s.distinctSessions) : 0,
    }))
    .sort((x, y) => y.total - x.total);
  const sessions = sum(reports.map((r) => r.totals?.sessions));
  const skillReport = skillList.length
    ? {
        status: 'ok',
        totals: {
          invocations: sum(skillList.map((s) => s.total)),
          sessions,
          definedSkills: defined.size,
          loggedSkills: skillList.length,
          malformedLines: sum(reports.map((r) => r.totals?.malformedLines)),
        },
        skills: skillList,
        neverFired: [...defined].filter((n) => !skills.has(n)),
        ghosts: skillList.filter((s) => !s.defined).map((s) => ({ name: s.name, total: s.total })),
      }
    : { status: 'no-data', skills: [], neverFired: [...defined], ghosts: [] };
  // subagents
  const byType = new Map();
  let subTotal = 0;
  let subSessions = 0;
  const perSession = [];
  for (const r of reports) {
    const s = r.subagents;
    if (s?.status !== 'ok') continue;
    subTotal += s.total;
    subSessions += s.sessions;
    perSession.push(...(s.perSession ?? []));
    for (const t of s.byType ?? []) {
      const cur = byType.get(t.type) ?? { type: t.type, total: 0, sessions: 0 };
      cur.total += t.total;
      cur.sessions += t.sessions;
      byType.set(t.type, cur);
    }
  }
  const subagents = subTotal
    ? {
        status: 'ok',
        total: subTotal,
        sessions: subSessions,
        meanPerSession: subSessions ? round2(subTotal / subSessions) : 0,
        malformedLines: sum(reports.map((r) => r.subagents?.malformedLines)),
        byType: [...byType.values()].sort(
          (a, b) => b.total - a.total || a.type.localeCompare(b.type)
        ),
        perSession: perSession.sort((a, b) => b - a),
      }
    : { status: 'no-data' };
  // stop outcomes
  const checks = new Map();
  let blocked = 0;
  let allowed = 0;
  let reentrant = 0;
  for (const r of reports) {
    const s = r.stopOutcomes;
    if (s?.status !== 'ok') continue;
    blocked += s.blocked;
    allowed += s.allowed;
    reentrant += s.reentrant ?? 0;
    for (const c of s.checks ?? []) checks.set(c.name, (checks.get(c.name) ?? 0) + c.fired);
  }
  const stopTotal = blocked + allowed;
  const stopOutcomes =
    stopTotal || reentrant
      ? {
          status: 'ok',
          total: stopTotal,
          blocked,
          allowed,
          reentrant,
          blockRate: stopTotal ? round2(blocked / stopTotal) : 0,
          malformedLines: sum(reports.map((r) => r.stopOutcomes?.malformedLines)),
          checks: [...checks.entries()]
            .map(([name, n]) => ({
              name,
              fired: n,
              fireRate: stopTotal ? round2(n / stopTotal) : 0,
            }))
            .sort((a, b) => b.fired - a.fired || a.name.localeCompare(b.name)),
        }
      : { status: 'no-data' };
  return {
    ...skillReport,
    subagents,
    stopOutcomes,
    sources: [local.label ?? 'local', ...snapshots.map((s) => s.label)],
  };
}

export function snapshotPath(dir, label, date = new Date()) {
  return path.join(dir, `${date.toISOString().slice(0, 10)}--${label}.json`);
}

const localReport = {
  ...skillSection(),
  subagents: subagentSection(),
  stopOutcomes: stopSection(),
  label,
};

if (asSnapshot) {
  // Cumulative summary for this machine. Same-day re-runs overwrite (newer is a superset);
  // the merge keeps only the latest file per label, so older dated files are inert.
  const snapshot = {
    kind: 'metrics-snapshot',
    label,
    writtenAt: new Date().toISOString(),
    ...localReport,
  };
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const file = snapshotPath(snapshotsDir, label);
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `Wrote ${path.relative(root, file)} (counts only; commit it so other machines' reports can merge it).`
  );
  process.exit(0);
}

const report = merged
  ? mergeReports(localReport, latestSnapshots(snapshotsDir, { exclude: label }))
  : localReport;
const { subagents, stopOutcomes } = report;
const skillReport = report;

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// --- human-readable -------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);

if (merged && 'sources' in report) console.log(`Merged sources: ${report.sources.join(', ')}\n`);
if (skillReport.status === 'no-data') {
  console.log(
    `No skill-usage data yet. The PreToolUse(Skill) hook writes ${path.relative(
      root,
      logPath
    )} on first skill invocation.`
  );
  if (defined.size > 0) console.log(`Defined skills (none fired yet): ${[...defined].join(', ')}`);
} else {
  const { totals, skills, neverFired, ghosts } = skillReport;
  console.log(
    `Skill usage — ${totals.invocations} invocations across ${totals.sessions} sessions, ${totals.loggedSkills} distinct skills`
  );
  console.log('');
  console.log(
    pad('Skill', 28) +
      pad('Inv', 6) +
      pad('Sess', 6) +
      pad('Inv/Sess', 10) +
      pad('First', 21) +
      'Last'
  );
  console.log('-'.repeat(90));
  for (const s of skills) {
    console.log(
      pad(s.name, 28) +
        pad(s.total, 6) +
        pad(s.distinctSessions, 6) +
        pad(s.invocationsPerSession, 10) +
        pad(s.firstSeen.slice(0, 19), 21) +
        s.lastSeen.slice(0, 19)
    );
  }
  if (neverFired.length) console.log(`\nNever fired (broaden triggers?): ${neverFired.join(', ')}`);
  if (ghosts.length) {
    console.log(
      `Unknown in log (renamed/removed?): ${ghosts.map((g) => `${g.name} (${g.total})`).join(', ')}`
    );
  }
  if (totals.malformedLines) console.log(`\n${totals.malformedLines} malformed line(s) skipped.`);
}

console.log('');
if (subagents.status === 'no-data') {
  console.log('Subagents — no data yet (SubagentStop hook writes .claude/metrics/subagent.log).');
} else {
  console.log(
    `Subagents — ${subagents.total} runs across ${subagents.sessions} sessions (mean ${subagents.meanPerSession}/session, max ${subagents.perSession[0] ?? 0})`
  );
  console.log(`${pad('Agent type', 34) + pad('Runs', 6)}Sess`);
  console.log('-'.repeat(46));
  for (const t of subagents.byType) console.log(pad(t.type, 34) + pad(t.total, 6) + t.sessions);
}

console.log('');
if (stopOutcomes.status === 'no-data') {
  console.log(
    'Stop-hook outcomes — no data yet (stop-checks hook writes .claude/metrics/stop-outcomes.log).'
  );
} else {
  console.log(
    `Stop-hook outcomes — ${stopOutcomes.total} stops: ${stopOutcomes.blocked} blocked, ${stopOutcomes.allowed} allowed (block rate ${stopOutcomes.blockRate}); ${stopOutcomes.reentrant} re-entrant stops excluded`
  );
  console.log(`${pad('Check', 20) + pad('Fired', 7)}Fire rate`);
  console.log('-'.repeat(36));
  for (const c of stopOutcomes.checks) console.log(pad(c.name, 20) + pad(c.fired, 7) + c.fireRate);
}
