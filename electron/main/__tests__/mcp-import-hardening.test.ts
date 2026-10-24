// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

import { parseMcpConfigText } from '@shared/mcp-import/mcp-config-parser';
import {
  __mcpImportSessionCountForTests,
  __seedMcpImportSessionForTests,
  commitEntries,
  envIsHandleBacked,
  registerMcpImportIPC,
  scanSourceFiles,
  unregisterMcpImportIPC,
} from '../handlers/mcp-import-handler';
import { displayPath } from '../handlers/mcp-import-paths';
import { __setSecretStoreForTests, type SecretStoreShape } from '../security/secret-handle-store';

type Rec = { value: string; label?: string; createdAt: number };
function failingStore(failOnNthSet: number) {
  const data: Record<string, Rec> = {};
  let sets = 0;
  const store: SecretStoreShape & { data: Record<string, Rec> } = {
    data,
    get: (k: string) => data[k],
    set: (k: string, v: Rec) => {
      sets += 1;
      if (sets === failOnNthSet) throw new Error('disk full');
      data[k] = v;
    },
    delete: (k: string) => {
      delete data[k];
    },
    clear: () => {},
    has: (k: string) => k in data,
    get store() {
      return data;
    },
  };
  return store;
}

const entriesFor = (servers: Record<string, unknown>) =>
  new Map(
    parseMcpConfigText(JSON.stringify({ mcpServers: servers })).entries.map((e) => [
      `0.${e.key}`,
      e,
    ])
  );

afterAll(() => __setSecretStoreForTests(null));

describe('readBounded hardening (L1, L2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-import-h-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts a file of exactly the cap and rejects one byte more, whatever stat said', async () => {
    const head = '{"mcpServers":{"a":{"command":"x"}}}';
    const exact = path.join(dir, 'exact.json');
    writeFileSync(exact, head + ' '.repeat(1024 * 1024 - head.length));
    const over = path.join(dir, 'over.json');
    writeFileSync(over, head + ' '.repeat(1024 * 1024 - head.length + 1));
    const { sources } = await scanSourceFiles(
      [
        { label: 'exact', file: exact, optional: false },
        { label: 'over', file: over, optional: false },
      ],
      dir
    );
    expect(sources[0]?.error).toBeUndefined();
    expect(sources[0]?.entries).toHaveLength(1);
    expect(sources[1]?.error).toMatch(/larger than/);
  });

  it.skipIf(process.platform === 'win32')('does not hang on a FIFO', async () => {
    const fifo = path.join(dir, 'pipe.json');
    execFileSync('mkfifo', [fifo]);
    const { sources } = await scanSourceFiles(
      [{ label: 'fifo', file: fifo, optional: false }],
      dir
    );
    expect(sources[0]?.error).toBe('Not a regular file');
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks for detected files only', async () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, '{"mcpServers":{"a":{"command":"x"}}}');
    const link = path.join(dir, 'link.json');
    symlinkSync(real, link);
    const { sources } = await scanSourceFiles(
      [
        { label: 'detected', file: link, optional: true, rejectSymlink: true },
        { label: 'picked', file: link, optional: false },
        {
          label: 'absent',
          file: path.join(dir, 'absent.json'),
          optional: true,
          rejectSymlink: true,
        },
      ],
      dir
    );
    expect(sources).toHaveLength(2);
    expect(sources[0]?.error).toBe('Symbolic links are not followed');
    expect(sources[1]?.error).toBeUndefined();
    expect(sources[1]?.entries).toHaveLength(1);
  });
});

describe('commit rollback (L3)', () => {
  it('deletes every handle written in a failed batch and keeps the session for a retry', async () => {
    const store = failingStore(2);
    __setSecretStoreForTests(store);
    const entries = entriesFor({
      a: { command: 'x', env: { A_TOKEN: 'one' } },
      b: { command: 'y', env: { B_TOKEN: 'two' } },
    });
    expect(() => commitEntries(entries, ['0.0', '0.1'])).toThrow('disk full');
    expect(Object.keys(store.data)).toHaveLength(0);

    // Through IPC: the failed commit does not spend the session.
    const registered = new Map<string, (e: unknown, p?: unknown) => Promise<unknown>>();
    registerMcpImportIPC(() => null);
    for (const [c, h] of mockHandle.mock.calls) registered.set(c as string, h);
    const event = {
      sender: Object.assign(new EventEmitter(), { id: 31, isDestroyed: () => false }),
      senderFrame: { url: 'file:///app/dist/web/index.html' },
    };
    const sessionId = __seedMcpImportSessionForTests(31, entries);
    const retryStore = failingStore(1);
    __setSecretStoreForTests(retryStore);
    const commit = registered.get('mcp:import:commit');
    await expect(commit?.(event, { sessionId, keys: ['0.0'] })).rejects.toThrow('disk full');
    __setSecretStoreForTests(failingStore(0));
    const ok = (await commit?.(event, { sessionId, keys: ['0.0'] })) as { drafts: unknown[] };
    expect(ok.drafts).toHaveLength(1);
    await expect(commit?.(event, { sessionId, keys: ['0.0'] })).rejects.toThrow(/expired/);
    unregisterMcpImportIPC();
  });
});

describe('session limits (L4)', () => {
  beforeAll(() => vi.useFakeTimers());
  afterAll(() => vi.useRealTimers());

  it('caps sessions per owner and expires them on a timer', () => {
    unregisterMcpImportIPC();
    const entries = entriesFor({ a: { command: 'x' } });
    for (let i = 0; i < 6; i++) __seedMcpImportSessionForTests(77, entries);
    expect(__mcpImportSessionCountForTests()).toBe(4);
    __seedMcpImportSessionForTests(78, entries);
    expect(__mcpImportSessionCountForTests()).toBe(5);
    vi.advanceTimersByTime(11 * 60_000);
    expect(__mcpImportSessionCountForTests()).toBe(0);
  });

  it('evicts the oldest session globally at the overall cap', () => {
    const entries = entriesFor({ a: { command: 'x' } });
    for (let i = 0; i < 20; i++) __seedMcpImportSessionForTests(100 + i, entries);
    expect(__mcpImportSessionCountForTests()).toBe(16);
    unregisterMcpImportIPC();
    expect(__mcpImportSessionCountForTests()).toBe(0);
  });
});

describe('small fixes (L7)', () => {
  it('keeps values containing {{ plain', () => {
    expect(envIsHandleBacked({ name: 'API_KEY', value: 'abc{{X}}' })).toBe(false);
    expect(envIsHandleBacked({ name: 'API_KEY', value: 'abc' })).toBe(true);
  });

  it('only collapses the home directory on a path boundary', () => {
    expect(displayPath('/Users/mexx/.cursor/mcp.json', '/Users/me')).toBe(
      '/Users/mexx/.cursor/mcp.json'
    );
    expect(displayPath('/Users/me', '/Users/me')).toBe('~');
    expect(displayPath('C:\\Users\\me\\a.json', 'C:\\Users\\me')).toBe('~\\a.json');
  });
});
