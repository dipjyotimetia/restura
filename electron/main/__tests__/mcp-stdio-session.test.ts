// @vitest-environment node
import { type ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStderrForwarder,
  liveStdioChildCount,
  terminateAllStdioChildren,
  terminateStdioChild,
  trackStdioChild,
} from '../handlers/mcp-stdio-session';

const spawned: ChildProcess[] = [];

function spawnNode(code: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  spawned.push(child);
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

describe('stdio child lifecycle', () => {
  it('tracks a child until it exits and terminate() makes the pid disappear', async () => {
    const child = await spawnNode('setInterval(() => {}, 1000)');
    trackStdioChild(child);
    expect(liveStdioChildCount()).toBe(1);
    await terminateStdioChild(child, 1000);
    expect(isAlive(child.pid!)).toBe(false);
    expect(liveStdioChildCount()).toBe(0);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    if (process.platform === 'win32') return; // signals are emulated on Windows
    const child = await spawnNode(
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"
    );
    await new Promise((r) => child.stdout!.once('data', r));
    trackStdioChild(child);
    await terminateStdioChild(child, 200);
    expect(child.signalCode).toBe('SIGKILL');
    expect(isAlive(child.pid!)).toBe(false);
  });

  it('terminateAll kills every tracked child', async () => {
    const a = await spawnNode('setInterval(() => {}, 1000)');
    const b = await spawnNode('setInterval(() => {}, 1000)');
    trackStdioChild(a);
    trackStdioChild(b);
    expect(liveStdioChildCount()).toBe(2);
    await terminateAllStdioChildren(500);
    expect(isAlive(a.pid!)).toBe(false);
    expect(isAlive(b.pid!)).toBe(false);
    expect(liveStdioChildCount()).toBe(0);
  });

  it('a child that exits on its own is untracked (never signalled later)', async () => {
    const child = await spawnNode('setTimeout(() => process.exit(0), 20)');
    trackStdioChild(child);
    await new Promise((r) => child.once('exit', r));
    expect(liveStdioChildCount()).toBe(0);
    await terminateStdioChild(child); // no-op, must not throw
  });

  it('does not track an already-exited child', async () => {
    const child = await spawnNode('process.exit(0)');
    await new Promise((r) => child.once('exit', r));
    trackStdioChild(child)();
    expect(liveStdioChildCount()).toBe(0);
  });
});

describe('createStderrForwarder', () => {
  const limits = { maxChunkChars: 10, maxTotalChars: 25, tailChars: 8 };

  it('forwards small chunks verbatim', () => {
    const out: string[] = [];
    const f = createStderrForwarder((t) => out.push(t), limits);
    f.push(Buffer.from('hello'));
    f.push('');
    expect(out).toEqual(['hello']);
  });

  it('truncates oversized chunks and stops after the total budget', () => {
    const out: string[] = [];
    const f = createStderrForwarder((t) => out.push(t), limits);
    f.push('x'.repeat(15)); // chunk-capped at 10
    f.push('y'.repeat(10)); // 20 forwarded
    f.push('z'.repeat(10)); // only 5 more allowed → then limit notice
    f.push('dropped');
    expect(out[0]).toBe(`${'x'.repeat(10)}… [chunk truncated]\n`);
    expect(out[1]).toBe('y'.repeat(10));
    expect(out[2]).toBe(`${'z'.repeat(5)}… [chunk truncated]\n`);
    expect(out[3]).toMatch(/stderr limit reached/);
    expect(out).toHaveLength(4);
  });

  it('keeps a short tail even after the budget is exhausted', () => {
    const f = createStderrForwarder(() => {}, limits);
    f.push('a'.repeat(40));
    f.push('last line');
    expect(f.tail()).toBe('ast line');
  });
});
