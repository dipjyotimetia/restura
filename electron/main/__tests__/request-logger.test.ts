// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createElectronMock,
  trustedEvent,
  untrustedEvent,
  getRegisteredHandler,
  silenceLogger,
} from './helpers/electron-mock';

const { fsp } = vi.hoisted(() => ({
  fsp: {
    mkdir: vi.fn(async () => undefined),
    stat: vi.fn(),
    writeFile: vi.fn(async (_p: string, _data: string) => undefined),
    appendFile: vi.fn(async (_p: string, _data: string) => undefined),
    readFile: vi.fn(),
  },
}));

vi.mock('electron', () => createElectronMock());
vi.mock('fs/promises', () => fsp);
vi.mock('../../../src/lib/shared/logger', (orig) => silenceLogger(orig));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { logRequest, registerRequestLoggerIPC, type LogEntry } from '../request-logger';

const entry: LogEntry = {
  ts: 1,
  method: 'GET',
  url: 'https://x',
  status: 200,
  durationMs: 5,
  protocol: 'http',
};

describe('logRequest', () => {
  beforeEach(() => {
    Object.values(fsp).forEach((f) => f.mockClear());
    fsp.stat.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
  });

  it('appends a JSON line to the request log', async () => {
    logRequest(entry);
    await vi.waitFor(() => expect(fsp.appendFile).toHaveBeenCalled());
    const [, line] = fsp.appendFile.mock.calls[0]!;
    expect(JSON.parse(line.trim())).toMatchObject({ method: 'GET', status: 200 });
  });

  it('never throws even if the append fails', async () => {
    fsp.appendFile.mockRejectedValueOnce(new Error('disk full'));
    expect(() => logRequest(entry)).not.toThrow();
  });
});

describe('registerRequestLoggerIPC', () => {
  beforeEach(() => {
    Object.values(fsp).forEach((f) => f.mockReset());
    fsp.mkdir.mockResolvedValue(undefined);
    vi.mocked(ipcMain.handle).mockClear();
    registerRequestLoggerIPC();
  });

  function getHistory() {
    return getRegisteredHandler(ipcMain, IPC.log.getHistory) as (
      e: unknown,
      p?: unknown
    ) => Promise<LogEntry[]>;
  }

  it('registers log:get-history and log:clear', () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0]);
    expect(channels).toEqual(expect.arrayContaining([IPC.log.getHistory, IPC.log.clear]));
  });

  it('rejects an untrusted sender', async () => {
    await expect(getHistory()(untrustedEvent())).rejects.toThrow(/untrusted frame/i);
  });

  it('parses valid lines and skips malformed / schema-invalid ones', async () => {
    const valid = JSON.stringify(entry);
    const badJson = '{not json';
    const badSchema = JSON.stringify({ ts: 'x', method: 1 });
    fsp.readFile.mockResolvedValue([valid, badJson, badSchema, valid].join('\n'));

    const out = await getHistory()(trustedEvent(), 100);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ method: 'GET' });
  });

  it('respects the limit (returns the last N entries)', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ ...entry, ts: i })).join(
      '\n'
    );
    fsp.readFile.mockResolvedValue(lines);
    const out = await getHistory()(trustedEvent(), 2);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.ts)).toEqual([3, 4]);
  });

  it('returns [] when the log file does not exist', async () => {
    fsp.readFile.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await getHistory()(trustedEvent(), 10)).toEqual([]);
  });

  it('log:clear truncates the file for a trusted sender', async () => {
    fsp.writeFile.mockResolvedValue(undefined);
    const clear = getRegisteredHandler(ipcMain, IPC.log.clear) as (e: unknown) => Promise<void>;
    await clear(trustedEvent());
    expect(fsp.writeFile).toHaveBeenCalledWith(expect.any(String), '');
  });
});
