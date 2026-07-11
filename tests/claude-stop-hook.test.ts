import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
});
