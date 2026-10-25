import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SECRET = 'TOP-SECRET-PROMPT-CONTENT';

function sandbox(hooks: string[]): { temp: string; hooksDir: string } {
  const temp = mkdtempSync(join(tmpdir(), 'restura-metrics-hook-'));
  const hooksDir = join(temp, '.claude', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  for (const h of ['_shared.mjs', ...hooks]) {
    cpSync(resolve(process.cwd(), '.claude/hooks', h), join(hooksDir, h));
  }
  return { temp, hooksDir };
}

function runHook(hooksDir: string, hook: string, temp: string, payload: unknown) {
  return spawnSync('node', [join(hooksDir, hook)], {
    cwd: temp,
    env: { ...process.env, CLAUDE_PROJECT_DIR: temp },
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
}

describe('log-subagent hook (SubagentStop)', () => {
  it('appends one TSV line with metadata only — no prompt/transcript content', () => {
    const { temp, hooksDir } = sandbox(['log-subagent.mjs']);
    const res = runHook(hooksDir, 'log-subagent.mjs', temp, {
      session_id: 'sess-1',
      transcript_path: `/x/${SECRET}.jsonl`,
      cwd: temp,
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'def456',
      agent_type: 'Explore',
      agent_transcript_path: `/x/subagents/${SECRET}.jsonl`,
      last_assistant_message: `${SECRET}\twith\ttabs\nand newline`,
      prompt: SECRET,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const log = readFileSync(join(temp, '.claude', 'metrics', 'subagent.log'), 'utf8');
    const lines = log.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const cols = (lines[0] ?? '').split('\t');
    expect(cols[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cols.slice(1, 4)).toEqual(['sess-1', 'Explore', 'def456']);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('subagents/');
  });

  it('records duration/token fields when the payload provides them', () => {
    const { temp, hooksDir } = sandbox(['log-subagent.mjs']);
    runHook(hooksDir, 'log-subagent.mjs', temp, {
      session_id: 's',
      agent_id: 'a',
      agent_type: 't',
      duration_ms: 1234,
      total_tokens: 5678,
    });
    const line = readFileSync(join(temp, '.claude', 'metrics', 'subagent.log'), 'utf8');
    expect(line).toContain('1234');
    expect(line).toContain('5678');
  });

  it('never fails on bad input', () => {
    const { temp, hooksDir } = sandbox(['log-subagent.mjs']);
    const res = runHook(hooksDir, 'log-subagent.mjs', temp, 'not json');
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });
});

describe('stop-checks outcome logging', () => {
  it('logs fired check names and blocked=true without message content', () => {
    const { temp, hooksDir } = sandbox(['stop-checks.mjs']);
    mkdirSync(join(temp, 'src'), { recursive: true });
    writeFileSync(join(temp, 'src', 'changed.ts'), 'export const changed = true;\n');
    execFileSync('git', ['init'], { cwd: temp, stdio: 'ignore' });
    execFileSync('git', ['add', 'src/changed.ts'], { cwd: temp, stdio: 'ignore' });

    const res = runHook(hooksDir, 'stop-checks.mjs', temp, {
      session_id: 'sess-stop',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: SECRET,
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).decision).toBe('block');

    const log = readFileSync(join(temp, '.claude', 'metrics', 'stop-outcomes.log'), 'utf8');
    const lines = log.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const cols = (lines[0] ?? '').split('\t');
    expect(cols[1]).toBe('sess-stop');
    expect(cols[2]).toContain('type-check');
    expect(cols[3]).toBe('blocked');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('reminder:');
  });

  it('logs a non-blocking line when nothing changed', () => {
    const { temp, hooksDir } = sandbox(['stop-checks.mjs']);
    execFileSync('git', ['init'], { cwd: temp, stdio: 'ignore' });
    const res = runHook(hooksDir, 'stop-checks.mjs', temp, { session_id: 'sess-quiet' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    const path = join(temp, '.claude', 'metrics', 'stop-outcomes.log');
    expect(existsSync(path)).toBe(true);
    const cols = readFileSync(path, 'utf8').trimEnd().split('\t');
    expect(cols[1]).toBe('sess-quiet');
    expect(cols[2]).toBe('-');
    expect(cols[3]).toBe('allowed');
  });
});

describe('guard-generated-files hook: *.snap', () => {
  const run = (file: string) => {
    const { temp, hooksDir } = sandbox(['guard-generated-files.mjs']);
    return runHook(hooksDir, 'guard-generated-files.mjs', temp, {
      tool_name: 'Write',
      tool_input: { file_path: join(temp, file), content: 'x' },
    });
  };

  it('denies writing a .snap file with an inline-snapshot reason', () => {
    const res = run('src/__snapshots__/foo.test.ts.snap');
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/inline snapshots/i);
    expect(res.stderr).toMatch(/gitignored/i);
  });

  it('allows ordinary files', () => {
    expect(run('src/snapshot.ts').status).toBe(0);
  });

  it('denies the real generated OpenCollection types (gen-opencollection-types output)', () => {
    const res = run('shared/opencollection/spec-types.ts');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('npm run gen:opencollection-types');
  });

  it('allows the hand-written deprecated re-export shim', () => {
    expect(run('src/lib/opencollection/spec-types.ts').status).toBe(0);
  });

  it('denies the generated capability matrix', () => {
    const res = run('docs/CAPABILITY_MATRIX.md');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('npm run capabilities:matrix');
  });

  it('denies buf-generated protobuf TS (proto:gen output)', () => {
    const res = run('e2e/mocks/proto/gen/echo_pb.ts');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('npm run proto:gen');
  });
});
