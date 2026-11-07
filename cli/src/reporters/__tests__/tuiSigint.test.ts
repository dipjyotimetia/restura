import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../types';

// The animated shell only runs in a TTY; force it on and silence the terminal.
vi.mock('../../ui/colors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ui/colors.js')>();
  return { ...actual, interactive: true, hideCursor: vi.fn(), showCursor: vi.fn() };
});
vi.mock('log-update', () => {
  const logUpdate = Object.assign(vi.fn(), { clear: vi.fn(), done: vi.fn() });
  return { default: logUpdate };
});

const { TuiReporter } = await import('../tui');
const colors = await import('../../ui/colors.js');
const logUpdate = (await import('log-update')).default as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TuiReporter Ctrl-C', () => {
  it('tears the display down without exiting, leaving cancellation to `restura run`', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const before = process.listeners('SIGINT');
    const reporter = new TuiReporter();
    reporter.onStart({ collectionName: 'C', collectionDir: '/tmp', startedAt: 0, total: 1 });

    const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();

    expect(exit).not.toHaveBeenCalled();
    expect(colors.showCursor).toHaveBeenCalled();
    // The listener is gone and the dashboard no longer redraws.
    expect(process.listeners('SIGINT')).not.toContain(added[0]);
    logUpdate.mockClear();
    reporter.onRequestStart({
      relativePath: 'r.yaml',
      folderPath: [],
      type: 'http',
      request: { name: 'R', method: 'GET' },
    } as never);
    expect(logUpdate).not.toHaveBeenCalled();

    // The run still finishes through onEnd (partial summary printed).
    const result: RunResult = {
      meta: { collectionName: 'C', collectionDir: '/tmp', startedAt: 0, total: 1 },
      durationMs: 1,
      requests: [],
      summary: { total: 0, passed: 0, failed: 0, errored: 0 },
      interrupted: true,
    };
    reporter.onEnd(result);
    expect(logUpdate.clear).toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
