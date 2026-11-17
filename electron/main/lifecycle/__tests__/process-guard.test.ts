// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const exit = vi.hoisted(() => vi.fn());
const showErrorBox = vi.hoisted(() => vi.fn());
const getFile = vi.hoisted(() => vi.fn(() => ({ path: '/tmp/restura/main.log' })));

vi.mock('electron', () => ({
  app: { exit },
  dialog: { showErrorBox },
}));

vi.mock('electron-log/main', () => ({
  default: { transports: { file: { getFile } } },
}));

const savedException = process.listeners('uncaughtException');
const savedRejection = process.listeners('unhandledRejection');

afterEach(() => {
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  for (const listener of savedException) {
    process.on('uncaughtException', listener);
  }
  for (const listener of savedRejection) {
    process.on('unhandledRejection', listener);
  }
  delete process.env.RESTURA_SMOKE;
  exit.mockClear();
  showErrorBox.mockClear();
  getFile.mockReset();
  getFile.mockImplementation(() => ({ path: '/tmp/restura/main.log' }));
  vi.resetModules();
});

async function loadGuard() {
  return import('../process-guard');
}

function lastListener(event: 'uncaughtException' | 'unhandledRejection') {
  const listeners = process.listeners(event);
  const listener = listeners[listeners.length - 1];
  if (!listener) throw new Error(`no ${event} listener`);
  return listener;
}

describe('process guard', () => {
  it('reads the log path and falls back when electron-log throws', async () => {
    const { logFilePath } = await loadGuard();
    expect(logFilePath()).toBe('/tmp/restura/main.log');
    getFile.mockImplementation(() => {
      throw new Error('no log yet');
    });
    expect(logFilePath()).toBe('the Restura log');
  });

  it('exits 1 on an uncaught exception during pack smoke and does not show a dialog', async () => {
    process.env.RESTURA_SMOKE = '1';
    const error = vi.fn();
    const { installProcessGuards } = await loadGuard();
    installProcessGuards({ error });
    const listener = lastListener('uncaughtException') as (err: unknown, origin: string) => void;
    listener(new Error('missing native'), 'uncaughtException');
    expect(exit).toHaveBeenCalledWith(1);
    expect(showErrorBox).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'uncaughtException',
      expect.objectContaining({ message: 'missing native', origin: 'uncaughtException' })
    );
  });

  it('shows one dialog for an uncaught exception and logs a rejection', async () => {
    const error = vi.fn();
    const { installProcessGuards } = await loadGuard();
    installProcessGuards({ error });
    const onException = lastListener('uncaughtException') as (err: unknown, origin: string) => void;
    onException('boom', 'uncaughtException');
    onException(new Error('again'), 'uncaughtException');
    expect(showErrorBox).toHaveBeenCalledTimes(1);
    expect(showErrorBox.mock.calls[0]?.[0]).toMatch(/unexpected error/);
    expect(showErrorBox.mock.calls[0]?.[1]).toContain('boom');
    expect(showErrorBox.mock.calls[0]?.[1]).toContain('/tmp/restura/main.log');
    expect(exit).not.toHaveBeenCalled();

    const onRejection = lastListener('unhandledRejection') as (reason: unknown) => void;
    onRejection(new Error('rejected'));
    onRejection('plain');
    expect(error).toHaveBeenCalledWith(
      'unhandledRejection',
      expect.objectContaining({ message: 'rejected' })
    );
    expect(error).toHaveBeenCalledWith(
      'unhandledRejection',
      expect.objectContaining({ message: 'plain', stack: undefined })
    );
  });

  it('stays quiet in smoke mode and shows one dialog otherwise', async () => {
    const { reportFeatureFailures } = await loadGuard();
    const failure = [{ feature: 'mcp-control', message: 'Cannot find module' }];
    reportFeatureFailures([]);
    expect(showErrorBox).not.toHaveBeenCalled();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.RESTURA_SMOKE = '1';
    reportFeatureFailures(failure);
    expect(spy).toHaveBeenCalled();
    expect(showErrorBox).not.toHaveBeenCalled();
    spy.mockRestore();

    delete process.env.RESTURA_SMOKE;
    reportFeatureFailures(failure);
    expect(showErrorBox).toHaveBeenCalledTimes(1);
    expect(showErrorBox.mock.calls[0]?.[1]).toContain('mcp-control');
  });

  it('exits 0 when the smoke window loads and 1 when the main frame fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.RESTURA_SMOKE = '1';
    const { watchSmokeWindow } = await loadGuard();

    const listeners = new Map<string, (...args: unknown[]) => void>();
    const win = {
      webContents: {
        once: (event: string, cb: (...args: unknown[]) => void) => {
          listeners.set(`once:${event}`, cb);
        },
        on: (event: string, cb: (...args: unknown[]) => void) => {
          listeners.set(`on:${event}`, cb);
        },
      },
    };
    watchSmokeWindow(win as never);
    listeners.get('once:did-finish-load')?.();
    listeners.get('once:did-finish-load')?.();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenCalledWith('restura-smoke-ready');

    exit.mockClear();
    listeners.clear();
    watchSmokeWindow(win as never);
    listeners.get('on:did-fail-load')?.({}, -2, 'ERR_FAILED', 'file://app', false);
    expect(exit).not.toHaveBeenCalled();
    listeners.get('on:did-fail-load')?.({}, -2, 'ERR_FAILED', 'file://app', true);
    listeners.get('on:did-fail-load')?.({}, -3, 'again', 'file://app', true);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.some((call) => String(call[0]).includes('restura-smoke-failed'))).toBe(
      true
    );

    delete process.env.RESTURA_SMOKE;
    exit.mockClear();
    listeners.clear();
    watchSmokeWindow(win as never);
    expect(listeners.size).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    log.mockRestore();
    err.mockRestore();
  });
});
