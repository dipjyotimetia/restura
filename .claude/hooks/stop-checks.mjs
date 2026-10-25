#!/usr/bin/env node
// Stop hook — all end-of-turn checks, driven by ONE shared git changed-set.
//
// Consolidates what were three separate Stop hooks (docs-site reminder,
// AGENTS.md drift, type-check reminder) plus the per-edit Biome pass. Computing
// the branch diff once and linting once per turn — instead of re-running git in
// three processes and booting Biome on every edit — removes the duplicated
// work the old layout paid on every turn.
//
// Each concern keeps its own .git dedup marker so it nags independently and at
// most once per distinct change. Markers are written only AFTER the combined
// reminder has been emitted, so a check that throws (or a failed write) never
// burns another check's marker and silently drops its reminder. Each check runs
// in its own try/catch for the same reason. Contract: never throws, always
// exits 0; output is a single blocking Stop decision with a reason (or nothing).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendMetric, binPath, changedFiles, projectDir, readPayload } from './_shared.mjs';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cwd = projectDir();

// Deferred dedup markers — same file format as _shared.mjs firstTimeFor (sha1 of
// the signature in .git/<marker>), but split into "is it new?" and "mark it".
const pendingMarks = new Map(); // check name -> { path, hash }
let currentCheck = '';

function markerFor(markerName, signature) {
  return {
    path: join(cwd, '.git', markerName),
    hash: createHash('sha1').update(signature).digest('hex'),
  };
}

/** True when this signature hasn't been reported yet; queues the marker for this check. */
function unseen(markerName, signature) {
  const m = markerFor(markerName, signature);
  let last = '';
  try {
    last = readFileSync(m.path, 'utf8').trim();
  } catch {
    // no marker yet
  }
  if (last === m.hash) return false;
  pendingMarks.set(currentCheck, m);
  return true;
}

function writeMark(m) {
  try {
    writeFileSync(m.path, m.hash);
  } catch {
    // best-effort; worst case the reminder repeats once
  }
}

// --- docs-site parity: a major surface changed but docs-site/ didn't ---
const MAJOR_PREFIXES = [
  'src/features/',
  'shared/protocol/',
  'electron/main/',
  'worker/',
  'docs/adr/',
  'src/lib/shared/capabilities/',
];
const MAJOR_FILES = new Set(['src/lib/shared/capabilities.ts']);
const isMajor = (p) => MAJOR_PREFIXES.some((x) => p.startsWith(x)) || MAJOR_FILES.has(p);

function docsSiteMessage(all) {
  const major = [...all].filter(isMajor).sort();
  if (major.length === 0) return null;
  if ([...all].some((f) => f.startsWith('docs-site/'))) return null;
  if (!unseen('restura-docs-site-reminder', major.join('\n'))) return null;
  const sample = major.slice(0, 4).join(', ') + (major.length > 4 ? ', …' : '');
  return (
    `📝 docs-site reminder: this branch changed a major surface (${sample}) ` +
    `but nothing under docs-site/. User-facing docs aren't gated by CI — ` +
    `run /docs-sync to update the guide/ADR/capability pages, or confirm none are stale.`
  );
}

// --- AGENTS.md drift: CLAUDE.md changed but AGENTS.md didn't ---
function agentsMdMessage(all) {
  if (!all.has('CLAUDE.md') || all.has('AGENTS.md')) return null;
  if (!unseen('restura-agents-md-drift-reminder', [...all].sort().join('\n'))) return null;
  return (
    `📝 agent-docs reminder: this branch changed CLAUDE.md but not AGENTS.md. ` +
    `The two agent-guidance files document the same architecture for Claude Code ` +
    `vs. Codex — mirror the relevant change into AGENTS.md (keeping its ` +
    `Codex-targeted framing), or confirm it doesn't apply there.`
  );
}

// --- type-check reminder: typed source changed (plain type-check is renderer-only) ---
const TS_ROOTS = ['src/', 'shared/', 'electron/', 'worker/', 'cli/', 'echo/', 'echo-local/'];
const isTypedSource = (p) => /\.(ts|tsx|mts|cts)$/.test(p) && TS_ROOTS.some((r) => p.startsWith(r));

function typeCheckMessage(all) {
  const typed = [...all].filter(isTypedSource).sort();
  if (typed.length === 0) return null;
  if (!unseen('restura-type-check-reminder', typed.join('\n'))) return null;
  const nonRenderer = typed.some((p) => !p.startsWith('src/'));
  const detail = nonRenderer
    ? 'including non-renderer code that plain `type-check` does NOT cover'
    : 'and the pre-commit hook does not run tsc';
  return (
    `🔎 type-check reminder: this branch changed TypeScript source (${detail}). ` +
    `Run \`npm run type-check:all\` before committing — plain \`type-check\` is renderer-only.`
  );
}

// --- lint: run Biome ONCE over the working-tree code files, surface problems ---
const LINT_ROOTS = [
  'src/',
  'shared/',
  'electron/main/',
  'worker/',
  'echo/',
  'echo-local/',
  'cli/',
  'tests/',
  'scripts/',
];
const CODE_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

function lintMessage(working) {
  const files = [...working].filter(
    (f) => CODE_EXT.test(f) && LINT_ROOTS.some((r) => f.startsWith(r)) && existsSync(join(cwd, f))
  );
  if (files.length === 0) return null;
  const biome = binPath('biome', cwd);
  if (!biome) return null;

  // Skip the (~1s) Biome run entirely when no candidate file changed since the
  // last lint. The signature is the file set + their mtimes; if it's unchanged
  // we've already linted this exact state, so there's nothing new to report.
  const sig = files
    .map((f) => {
      try {
        return `${f}:${statSync(join(cwd, f)).mtimeMs}`;
      } catch {
        return f;
      }
    })
    .sort()
    .join('|');
  if (!unseen('restura-lint-stop', sig)) return null;

  let out = '';
  try {
    // Report-only (no --write): formatting is applied per-edit by Biome, and
    // lint-staged runs `biome check --write` at commit.
    execFileSync(biome, ['lint', ...files], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`.trim();
  }
  if (!out) {
    // Clean is a final answer (nothing to lose), so remember this state now and
    // skip re-running Biome until a candidate file changes.
    const m = pendingMarks.get(currentCheck);
    if (m) writeMark(m);
    pendingMarks.delete(currentCheck);
    return null;
  }
  return (
    `⚠️ Biome found problems in changed files (\`npm run lint\` will fail in CI; ` +
    `\`npm run lint:fix\` auto-fixes most):\n${out.slice(0, 2000)}`
  );
}

// Outcome metrics: one TSV line per Stop in .claude/metrics/stop-outcomes.log —
// timestamp, session_id, fired check names (comma-joined, '-' if none),
// blocked|allowed|reentrant. Names only: never the reminder text or any payload
// content. `reentrant` = stop_hook_active (Claude is already continuing because
// a Stop hook blocked); the skills report excludes those from fire/block rates.
let sessionId;
let fired = [];
let outcome = 'allowed';

// Test-only fault injection (tests/claude-stop-hook.test.ts): throw inside the
// named check, or at 'emit' just before the decision is written.
const testThrow = process.env.RESTURA_STOP_CHECKS_TEST_THROW || '';

try {
  const payload = readPayload(); // also drains stdin
  sessionId = payload?.session_id;
  if (payload?.stop_hook_active === true) {
    // Blocking again risks a nag loop, so let it stop (still logged).
    outcome = 'reentrant';
  } else {
    const { all, working } = changedFiles(cwd);
    if (all.size > 0) {
      const checks = [
        { name: 'docs-site', run: () => docsSiteMessage(all) },
        { name: 'agents-md', run: () => agentsMdMessage(all) },
        { name: 'type-check', run: () => typeCheckMessage(all) },
        { name: 'lint', run: () => lintMessage(working) },
      ];
      const results = [];
      for (const c of checks) {
        currentCheck = c.name;
        try {
          const msg = c.run();
          if (testThrow === c.name) throw new Error(`test throw in ${c.name}`);
          if (msg) results.push({ name: c.name, msg });
        } catch {
          // one broken check must not take the others' reminders down with it
          pendingMarks.delete(c.name);
        }
      }
      currentCheck = '';

      if (results.length) {
        if (testThrow === 'emit') throw new Error('test throw at emit');
        process.stdout.write(
          JSON.stringify({ decision: 'block', reason: results.map((r) => r.msg).join('\n\n') })
        );
        fired = results.map((r) => r.name);
        outcome = 'blocked';
        // Only now that the reminder reached Claude is it "seen".
        for (const name of fired) {
          const m = pendingMarks.get(name);
          if (m) writeMark(m);
        }
      }
    }
  }
} catch {
  // intentionally empty — a checks hook must never break the session
}

appendMetric('stop-outcomes.log', [sessionId, fired.join(','), outcome], cwd);

process.exit(0);
