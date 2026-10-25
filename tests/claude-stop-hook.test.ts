import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Claude Stop hook', () => {
  it('emits valid Stop hook JSON when reminders are present', () => {
    const temp = mkdtempSync(join(tmpdir(), 'restura-stop-hook-'));
    const hooksDir = join(temp, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(join(temp, 'src'), { recursive: true });
    cpSync(resolve(process.cwd(), '.claude/hooks/_shared.mjs'), join(hooksDir, '_shared.mjs'));
    cpSync(
      resolve(process.cwd(), '.claude/hooks/stop-checks.mjs'),
      join(hooksDir, 'stop-checks.mjs')
    );
    writeFileSync(join(temp, 'src', 'changed.ts'), 'export const changed = true;\n');

    execFileSync('git', ['init'], { cwd: temp, stdio: 'ignore' });
    execFileSync('git', ['add', 'src/changed.ts'], { cwd: temp, stdio: 'ignore' });

    const output = execFileSync('node', [join(hooksDir, 'stop-checks.mjs')], {
      cwd: temp,
      env: { ...process.env, CLAUDE_PROJECT_DIR: temp },
      input: JSON.stringify({
        session_id: 'test',
        transcript_path: join(temp, 'transcript.jsonl'),
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
      encoding: 'utf8',
    });

    const parsed = JSON.parse(output) as { decision?: string; reason?: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('type-check reminder');
  });

  it('does not block again when stop_hook_active is true, and logs it as reentrant', () => {
    const temp = mkdtempSync(join(tmpdir(), 'restura-stop-hook-active-'));
    const hooksDir = join(temp, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(join(temp, 'src'), { recursive: true });
    cpSync(resolve(process.cwd(), '.claude/hooks/_shared.mjs'), join(hooksDir, '_shared.mjs'));
    cpSync(
      resolve(process.cwd(), '.claude/hooks/stop-checks.mjs'),
      join(hooksDir, 'stop-checks.mjs')
    );
    writeFileSync(join(temp, 'src', 'changed.ts'), 'export const changed = true;\n');
    execFileSync('git', ['init'], { cwd: temp, stdio: 'ignore' });
    execFileSync('git', ['add', 'src/changed.ts'], { cwd: temp, stdio: 'ignore' });

    const output = execFileSync('node', [join(hooksDir, 'stop-checks.mjs')], {
      cwd: temp,
      env: { ...process.env, CLAUDE_PROJECT_DIR: temp },
      input: JSON.stringify({
        session_id: 'loop',
        hook_event_name: 'Stop',
        stop_hook_active: true,
      }),
      encoding: 'utf8',
    });

    expect(output).toBe('');
    const cols = readFileSync(join(temp, '.claude', 'metrics', 'stop-outcomes.log'), 'utf8')
      .trimEnd()
      .split('\t');
    expect(cols.slice(1)).toEqual(['loop', '-', 'reentrant']);
  });

  it("a throwing check never swallows another check's reminder", () => {
    const temp = mkdtempSync(join(tmpdir(), 'restura-stop-hook-throw-'));
    const hooksDir = join(temp, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(join(temp, 'src'), { recursive: true });
    cpSync(resolve(process.cwd(), '.claude/hooks/_shared.mjs'), join(hooksDir, '_shared.mjs'));
    cpSync(
      resolve(process.cwd(), '.claude/hooks/stop-checks.mjs'),
      join(hooksDir, 'stop-checks.mjs')
    );
    writeFileSync(join(temp, 'src', 'changed.ts'), 'export const changed = true;\n');
    execFileSync('git', ['init'], { cwd: temp, stdio: 'ignore' });
    execFileSync('git', ['add', 'src/changed.ts'], { cwd: temp, stdio: 'ignore' });

    const run = (throwIn = '') =>
      execFileSync('node', [join(hooksDir, 'stop-checks.mjs')], {
        cwd: temp,
        env: { ...process.env, CLAUDE_PROJECT_DIR: temp, RESTURA_STOP_CHECKS_TEST_THROW: throwIn },
        input: JSON.stringify({ session_id: 's', hook_event_name: 'Stop' }),
        encoding: 'utf8',
      });
    const reason = (out: string) => (out ? (JSON.parse(out) as { reason: string }).reason : '');

    // type-check runs (and, before the fix, wrote its marker) before lint throws.
    expect(reason(run('lint'))).toContain('type-check reminder');
    // The emitted reminder is deduped on the next stop.
    expect(run()).toBe('');

    // A throw in an EARLIER check must not lose a later reminder either.
    writeFileSync(join(temp, 'src', 'other.ts'), 'export const other = 1;\n');
    execFileSync('git', ['add', 'src/other.ts'], { cwd: temp, stdio: 'ignore' });
    expect(reason(run('docs-site'))).toContain('type-check reminder');
  });

  it('a reminder whose emission is lost is not marked as seen', () => {
    const temp = mkdtempSync(join(tmpdir(), 'restura-stop-hook-mark-'));
    const hooksDir = join(temp, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(join(temp, 'src'), { recursive: true });
    cpSync(resolve(process.cwd(), '.claude/hooks/_shared.mjs'), join(hooksDir, '_shared.mjs'));
    cpSync(
      resolve(process.cwd(), '.claude/hooks/stop-checks.mjs'),
      join(hooksDir, 'stop-checks.mjs')
    );
    writeFileSync(join(temp, 'src', 'changed.ts'), 'export const changed = true;\n');
    execFileSync('git', ['init'], { cwd: temp, stdio: 'ignore' });
    execFileSync('git', ['add', 'src/changed.ts'], { cwd: temp, stdio: 'ignore' });
    const run = (throwIn = '') =>
      execFileSync('node', [join(hooksDir, 'stop-checks.mjs')], {
        cwd: temp,
        env: { ...process.env, CLAUDE_PROJECT_DIR: temp, RESTURA_STOP_CHECKS_TEST_THROW: throwIn },
        input: JSON.stringify({ session_id: 's', hook_event_name: 'Stop' }),
        encoding: 'utf8',
      });
    // Emission itself fails: nothing reaches Claude, so nothing may be marked seen.
    expect(run('emit')).toBe('');
    expect(run()).toContain('type-check reminder');
  });
});
