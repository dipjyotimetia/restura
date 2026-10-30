#!/usr/bin/env node
// SessionStart hook — tell Claude when the toolchain or dependencies are not
// what the repo expects, instead of letting the harness degrade silently.
//
// Why: `format-edit.mjs` and the Biome lint in `stop-checks.mjs` return early
// when `node_modules/.bin/biome` is missing, `npm ci` refuses the wrong Node or
// npm (`engine-strict=true`, scripts/verify-toolchain.mjs pins exact versions),
// and a linked worktree has no node_modules until `npm run worktree:setup`.
// A fresh cloud container or worktree therefore loses formatting, lint and
// test feedback with no message. This hook prints ONE short note up front.
//
// Output: a SessionStart `additionalContext` block (hookSpecificOutput) when
// something is off; nothing when all is well. Contract: never throws, always
// exits 0, never blocks the session. Runs in well under a second (one `npm
// --version` at most; skipped when npm cannot be found).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, readPayload } from './_shared.mjs';

/** `.nvmrc` content ("24.18.0", "v24.18.0", "24") → version string, or null. */
export function readNvmrc(cwd) {
  try {
    const raw = readFileSync(join(cwd, '.nvmrc'), 'utf8').trim();
    const m = raw.match(/^v?(\d+(?:\.\d+){0,2})$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** package.json `engines.npm` when it pins an exact version ("12.1.0"); null otherwise. */
export function readExactNpmEngine(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const npm = pkg?.engines?.npm;
    return typeof npm === 'string' && /^\d+\.\d+\.\d+$/.test(npm) ? npm : null;
  } catch {
    return null;
  }
}

/** True when `actual` satisfies `wanted` ("24" matches 24.x.y; "24.18.0" is exact). */
export function versionMatches(wanted, actual) {
  if (!wanted || !actual) return true; // unknown → do not nag
  const w = wanted.split('.');
  const a = actual.split('.');
  return w.every((part, i) => part === a[i]);
}

/** A linked worktree has a `.git` FILE (gitdir pointer); the main checkout has a directory. */
export function isLinkedWorktree(cwd) {
  try {
    return statSync(join(cwd, '.git')).isFile();
  } catch {
    return false;
  }
}

/**
 * Pure: the notes to show for this environment. `probe` supplies what the
 * hook observed so tests can drive every branch without a real toolchain.
 * @param {{ nvmrc: string|null; nodeVersion: string; npmEngine: string|null; npmVersion: string|null;
 *           hasBiome: boolean; hasVitest: boolean; linkedWorktree: boolean }} probe
 */
export function toolchainNotes(probe) {
  const notes = [];
  if (!versionMatches(probe.nvmrc, probe.nodeVersion)) {
    notes.push(
      `Node ${probe.nvmrc} is required (.nvmrc) but this session runs Node ${probe.nodeVersion}. ` +
        '`npm ci` will refuse (engine-strict) and `npm run toolchain:check` fails; install the pinned ' +
        'Node (nvm/fnm/volta honour .nvmrc) before running any gate.'
    );
  }
  if (probe.npmEngine && probe.npmVersion && probe.npmEngine !== probe.npmVersion) {
    notes.push(
      `npm ${probe.npmEngine} is required (package.json engines) but ${probe.npmVersion} is installed: ` +
        `\`npm install -g npm@${probe.npmEngine}\`.`
    );
  }
  if (!probe.hasBiome || !probe.hasVitest) {
    const missing = [!probe.hasBiome && 'biome', !probe.hasVitest && 'vitest'].filter(Boolean);
    const fix = probe.linkedWorktree
      ? '`npm run worktree:setup` (links node_modules from the main checkout)'
      : '`npm ci`';
    notes.push(
      `Dependencies are not installed (missing node_modules/.bin/${missing.join(', ')}). ` +
        'Until they are, the per-edit Biome formatter and the end-of-turn lint check are silently ' +
        `inactive and no test or type-check gate can run. Fix: ${fix}.`
    );
  }
  return notes;
}

export function probeEnvironment(cwd, { exec = execFileSync, nodeVersion = process.versions.node } = {}) {
  const bin = (name) => existsSync(join(cwd, 'node_modules', '.bin', name));
  let npmVersion = null;
  try {
    npmVersion = String(exec('npm', ['--version'], { encoding: 'utf8', timeout: 5000 })).trim();
  } catch {
    // npm missing or slow: skip the npm check rather than delay the session
  }
  return {
    nvmrc: readNvmrc(cwd),
    nodeVersion,
    npmEngine: readExactNpmEngine(cwd),
    npmVersion,
    hasBiome: bin('biome'),
    hasVitest: bin('vitest'),
    linkedWorktree: isLinkedWorktree(cwd),
  };
}

export function formatContext(notes) {
  return `Toolchain check (SessionStart hook):\n${notes.map((n) => `- ${n}`).join('\n')}`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  try {
    readPayload(); // drain stdin; the payload carries nothing this hook needs
    const notes = toolchainNotes(probeEnvironment(projectDir()));
    if (notes.length > 0) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: formatContext(notes),
          },
        })
      );
    }
  } catch {
    // never block a session on a hook bug
  }
  process.exit(0);
}
