// The SessionStart hook tells Claude when the toolchain or dependencies are
// missing, because the formatter/lint hooks otherwise no-op silently.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK = resolve(process.cwd(), '.claude/hooks/session-start.mjs');

function sandbox(): { temp: string; hooksDir: string } {
  const temp = mkdtempSync(join(tmpdir(), 'restura-session-start-'));
  const hooksDir = join(temp, '.claude', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  for (const h of ['_shared.mjs', 'session-start.mjs']) {
    cpSync(resolve(process.cwd(), '.claude/hooks', h), join(hooksDir, h));
  }
  return { temp, hooksDir };
}

function run(hooksDir: string, temp: string) {
  return spawnSync('node', [join(hooksDir, 'session-start.mjs')], {
    cwd: temp,
    env: { ...process.env, CLAUDE_PROJECT_DIR: temp },
    input: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
  });
}

describe('session-start hook (pure helpers)', async () => {
  const mod = await import(HOOK);

  it('versionMatches treats a major-only .nvmrc as a range and exact pins as exact', () => {
    expect(mod.versionMatches('24', '24.18.0')).toBe(true);
    expect(mod.versionMatches('24.18.0', '24.18.0')).toBe(true);
    expect(mod.versionMatches('24.18.0', '24.17.0')).toBe(false);
    expect(mod.versionMatches('24', '22.22.0')).toBe(false);
    expect(mod.versionMatches(null, '22.0.0')).toBe(true); // unknown wanted: no nag
  });

  it('toolchainNotes is silent when everything matches', () => {
    expect(
      mod.toolchainNotes({
        nvmrc: '24.18.0',
        nodeVersion: '24.18.0',
        npmEngine: '12.1.0',
        npmVersion: '12.1.0',
        hasBiome: true,
        hasVitest: true,
        linkedWorktree: false,
      })
    ).toEqual([]);
  });

  it('toolchainNotes names each problem and the matching fix', () => {
    const notes: string[] = mod.toolchainNotes({
      nvmrc: '24.18.0',
      nodeVersion: '22.22.0',
      npmEngine: '12.1.0',
      npmVersion: '10.9.4',
      hasBiome: false,
      hasVitest: false,
      linkedWorktree: true,
    });
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/Node 24\.18\.0 is required .* runs Node 22\.22\.0/);
    expect(notes[1]).toContain('npm install -g npm@12.1.0');
    expect(notes[2]).toContain('biome, vitest');
    expect(notes[2]).toContain('npm run worktree:setup');
    expect(
      mod.toolchainNotes({
        nvmrc: '24.18.0',
        nodeVersion: '24.18.0',
        npmEngine: null,
        npmVersion: null,
        hasBiome: false,
        hasVitest: true,
        linkedWorktree: false,
      })[0]
    ).toContain('`npm ci`');
  });
});

describe('session-start hook (process)', () => {
  it('emits additionalContext when dependencies are missing and never fails', () => {
    const { temp, hooksDir } = sandbox();
    writeFileSync(join(temp, '.nvmrc'), `${process.versions.node}\n`);
    writeFileSync(join(temp, 'package.json'), '{"name":"x"}');
    const res = run(hooksDir, temp);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('Dependencies are not installed');
    expect(out.hookSpecificOutput.additionalContext).not.toContain('Node ');
  });

  it('stays silent when the toolchain and dependencies are present', () => {
    const { temp, hooksDir } = sandbox();
    writeFileSync(join(temp, '.nvmrc'), `${process.versions.node}\n`);
    writeFileSync(join(temp, 'package.json'), '{"name":"x"}');
    mkdirSync(join(temp, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(temp, 'node_modules', '.bin', 'biome'), '');
    writeFileSync(join(temp, 'node_modules', '.bin', 'vitest'), '');
    const res = run(hooksDir, temp);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('survives malformed stdin', () => {
    const { temp, hooksDir } = sandbox();
    const res = spawnSync('node', [join(hooksDir, 'session-start.mjs')], {
      cwd: temp,
      env: { ...process.env, CLAUDE_PROJECT_DIR: temp },
      input: 'not json',
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
  });
});
