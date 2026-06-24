#!/usr/bin/env node
/**
 * Aggregate .claude/metrics/skill-usage.log into a per-skill usage report.
 *
 * The PreToolUse(Skill) hook (.claude/hooks/log-skill-usage.mjs) appends one
 * TSV line per skill invocation: `<ISO timestamp>\t<skill name>\t<session id>`.
 * This script turns that raw log into the *analysis* half of the
 * self-improvement loop described in Anthropic's "Lessons from building Claude
 * Code: how we use skills" — surfacing skills that over-trigger (high
 * invocations-per-session) or under-trigger (never fired) so their SKILL.md
 * `description` triggers can be tuned. The `/skill-report` command consumes the
 * `--json` output and proposes the actual description edits.
 *
 * Pure-Node ESM (no deps) so it runs at CI-time with no build step — mirrors
 * scripts/generate-capability-matrix.mjs. The log is git-ignored and
 * machine-local (.gitignore), so this is an advisory tool a human runs, NOT a
 * determinism gate: there is no `--check` mode.
 *
 * Privacy: session ids are used only to count distinct sessions, never printed.
 *
 * Usage:
 *   node scripts/skill-usage-report.mjs          # human-readable table
 *   node scripts/skill-usage-report.mjs --json    # machine JSON for /skill-report
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
// Agree with the hook's path resolution: it honours CLAUDE_PROJECT_DIR too.
const root = process.env.CLAUDE_PROJECT_DIR || repoRoot;
const logPath = path.join(root, '.claude', 'metrics', 'skill-usage.log');
const skillsDir = path.join(root, '.claude', 'skills');
const asJson = process.argv.includes('--json');

// Enumerate the skills that actually exist, by reading the `name:` frontmatter
// of each .claude/skills/*/SKILL.md (falling back to the directory name). This
// is the source-of-truth set we diff the log against to find never-fired
// (under-trigger) and ghost (renamed/removed) skills.
function definedSkills() {
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const md = path.join(skillsDir, d.name, 'SKILL.md');
      if (!fs.existsSync(md)) return null;
      const fm = fs.readFileSync(md, 'utf8').split('---')[1] ?? '';
      const m = fm.match(/^name:\s*(.+)$/m);
      return m ? m[1].trim() : d.name;
    })
    .filter(Boolean);
}

const defined = new Set(definedSkills());

if (!fs.existsSync(logPath)) {
  if (asJson) {
    console.log(
      JSON.stringify(
        { status: 'no-data', skills: [], neverFired: [...defined], ghosts: [] },
        null,
        2
      )
    );
  } else {
    console.log(
      `No skill-usage data yet. The PreToolUse(Skill) hook writes ${path.relative(
        root,
        logPath
      )} on first skill invocation.`
    );
    if (defined.size > 0) {
      console.log(`Defined skills (none fired yet): ${[...defined].join(', ')}`);
    }
  }
  process.exit(0);
}

const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);

const agg = new Map();
const allSessions = new Set();
let malformed = 0;
for (const line of lines) {
  const [ts, skill, session = '-'] = line.split('\t');
  if (!ts || !skill || Number.isNaN(Date.parse(ts))) {
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
    invocationsPerSession: Math.round((a.total / a.sessions.size) * 100) / 100,
    firstSeen: a.first,
    lastSeen: a.last,
    defined: defined.has(name),
  }))
  .sort((x, y) => y.total - x.total);

const neverFired = [...defined].filter((n) => !agg.has(n));
const ghosts = skills.filter((s) => !s.defined).map((s) => ({ name: s.name, total: s.total }));
const invocations = lines.length - malformed;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        status: 'ok',
        totals: {
          invocations,
          sessions: allSessions.size,
          definedSkills: defined.size,
          loggedSkills: agg.size,
          malformedLines: malformed,
        },
        skills,
        neverFired,
        ghosts,
      },
      null,
      2
    )
  );
  process.exit(0);
}

// Human-readable table.
const pad = (s, n) => String(s).padEnd(n);
console.log(
  `Skill usage — ${invocations} invocations across ${allSessions.size} sessions, ${agg.size} distinct skills`
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
if (neverFired.length) {
  console.log(`\nNever fired (broaden triggers?): ${neverFired.join(', ')}`);
}
if (ghosts.length) {
  console.log(
    `Unknown in log (renamed/removed?): ${ghosts.map((g) => `${g.name} (${g.total})`).join(', ')}`
  );
}
if (malformed) {
  console.log(`\n${malformed} malformed line(s) skipped.`);
}
