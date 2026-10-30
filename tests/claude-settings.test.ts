// Static checks on .claude/settings.json and the logging hooks: every hook
// command points at a file that exists, the permission deny list keeps local
// secrets away from the file tools, machine-local allowlists never ship, and
// the metrics hooks write metadata only.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const settings = JSON.parse(readFileSync(resolve(ROOT, '.claude/settings.json'), 'utf8'));

describe('.claude/settings.json', () => {
  it('every hook command references a hook file that exists', () => {
    const commands: string[] = [];
    for (const groups of Object.values(
      settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    )) {
      for (const g of groups) for (const h of g.hooks) commands.push(h.command);
    }
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      const m = c.match(/\$CLAUDE_PROJECT_DIR\/(\S+?)"?$/);
      expect(m, c).not.toBeNull();
      expect(existsSync(resolve(ROOT, m?.[1] ?? '')), c).toBe(true);
    }
  });

  it('registers the toolchain check on SessionStart', () => {
    const cmds = settings.hooks.SessionStart.flatMap((g: { hooks: Array<{ command: string }> }) =>
      g.hooks.map((h) => h.command)
    );
    expect(cmds.some((c: string) => c.includes('session-start.mjs'))).toBe(true);
  });

  it('denies the file tools access to local secret files', () => {
    const deny: string[] = settings.permissions?.deny ?? [];
    for (const required of [
      'Read(./.env)',
      'Read(./.env.local)',
      'Read(./.dev.vars)',
      'Read(~/.ssh/**)',
    ]) {
      expect(deny, required).toContain(required);
    }
    // Tracked example files stay readable: the deny list must not cover them.
    expect(deny).not.toContain('Read(./.env.*)');
    expect(deny).not.toContain('Read(./.dev.vars.*)');
  });

  it('never ships blanket shell allows (those belong in settings.local.json, which is untracked)', () => {
    const allow: string[] = settings.permissions?.allow ?? [];
    const blanket = /^Bash\((git|node|npm|npx|python3?|sh|bash|curl|gh)(:| )\*\)$/;
    expect(allow.filter((a) => blanket.test(a))).toEqual([]);
    const tracked = execFileSync('git', ['ls-files', '.claude/settings.local.json'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('');
  });
});

function runHook(hook: string, payload: unknown) {
  const temp = mkdtempSync(join(tmpdir(), 'restura-logging-hook-'));
  const hooksDir = join(temp, '.claude', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  for (const h of ['_shared.mjs', hook])
    cpSync(resolve(ROOT, '.claude/hooks', h), join(hooksDir, h));
  const res = spawnSync('node', [join(hooksDir, hook)], {
    cwd: temp,
    env: { ...process.env, CLAUDE_PROJECT_DIR: temp },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { res, temp };
}

describe('logging hooks write metadata only', () => {
  it('log-skill-usage records skill name and session, never the arguments', () => {
    const { res, temp } = runHook('log-skill-usage.mjs', {
      session_id: 'sess-9',
      tool_name: 'Skill',
      tool_input: { skill: 'ship-check', args: 'SECRET-ARGS' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const line = readFileSync(join(temp, '.claude/metrics/skill-usage.log'), 'utf8').trim();
    expect(line.split('\t').slice(1)).toEqual(['ship-check', 'sess-9']);
    expect(line).not.toContain('SECRET-ARGS');
  });

  it('log-skill-usage ignores other tools', () => {
    const { temp } = runHook('log-skill-usage.mjs', { tool_name: 'Bash', tool_input: {} });
    expect(existsSync(join(temp, '.claude/metrics/skill-usage.log'))).toBe(false);
  });

  it('log-compaction records trigger and session, never the transcript path', () => {
    const { res, temp } = runHook('log-compaction.mjs', {
      session_id: 'sess-3',
      trigger: 'auto',
      transcript_path: '/home/someone/.claude/projects/private/transcript.jsonl',
    });
    expect(res.status).toBe(0);
    const line = readFileSync(join(temp, '.claude/metrics/compaction.log'), 'utf8').trim();
    expect(line.split('\t').slice(1)).toEqual(['auto', 'sess-3']);
    expect(line).not.toContain('transcript');
  });
});
