// @vitest-environment node

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import { vi } from 'vitest';

let tmpRoot = '';

vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn((name: string) => {
        switch (name) {
          case 'userData':
            return tmpRoot;
          case 'documents':
            return '/tmp/test-documents';
          case 'home':
            return '/tmp/test-home';
          default:
            return '/tmp/test-other';
        }
      }),
    },
    ipcMain: {
      handle: vi.fn(),
    },
  };
});

import {
  disposeBrunoExportHandlerIPC,
  registerBrunoExportHandlerIPC,
  safeSegments,
  saveBrunoEntriesToDirectory,
} from '../storage/bruno-export-handler';

describe('saveBrunoEntriesToDirectory', () => {
  beforeEach(async () => {
    // Deliberately under /tmp, not `os.tmpdir()` — on macOS the latter
    // resolves to /var/folders/..., which `isPathSafe`'s BLOCKED_ROOT_PATHS
    // rejects by design (system dir), unrelated to the behavior under test.
    tmpRoot = await fsp.mkdtemp(path.join('/tmp', 'bruno-export-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('rejects when the target directory is outside the allowed roots', async () => {
    const result = await saveBrunoEntriesToDirectory('/etc/not-allowed', [
      { relativePath: 'bruno.json', content: '{}' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Access denied/);
  });

  it('rejects an entry whose relativePath escapes the target directory', async () => {
    const target = path.join(tmpRoot, 'export-target');
    const result = await saveBrunoEntriesToDirectory(target, [
      { relativePath: '../../etc/passwd', content: 'evil' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid path segment|outside target directory/);

    // Nothing should have been written outside the target.
    await expect(fsp.access('/etc/passwd_should_not_exist')).rejects.toThrow();
  });

  it('writes entries (including nested folders) to the target directory', async () => {
    const target = path.join(tmpRoot, 'export-target');
    const entries = [
      { relativePath: 'bruno.json', content: '{"version":"1"}' },
      { relativePath: 'get-user.bru', content: 'meta { name: Get User }' },
      { relativePath: 'environments/dev.bru', content: 'vars { host: localhost }' },
    ];

    const result = await saveBrunoEntriesToDirectory(target, entries);
    expect(result.success).toBe(true);

    for (const entry of entries) {
      const written = await fsp.readFile(path.join(target, entry.relativePath), 'utf-8');
      expect(written).toBe(entry.content);
    }
  });

  it('replace deletes only export-layout files (no symlinks followed), then writes', async () => {
    const target = path.join(tmpRoot, 'export-target');
    const dir = path.join(target, 'API');
    await fsp.mkdir(path.join(dir, 'Old', '.resources'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'Stale.request.yaml'), 'old');
    await fsp.writeFile(path.join(dir, 'Old', '.resources', 'definition.yaml'), 'old');
    await fsp.writeFile(path.join(dir, 'definition.yaml'), 'not under .resources');
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'keep');
    const outside = path.join(tmpRoot, 'outside');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'Victim.request.yaml'), 'keep');
    await fsp.symlink(outside, path.join(dir, 'linked'));
    const result = await saveBrunoEntriesToDirectory(
      target,
      [{ relativePath: 'API/New.request.yaml', content: 'new' }],
      { replace: { layout: 'postman-v3', subdir: 'API' } }
    );
    expect(result).toEqual({ success: true });
    const left = (await fsp.readdir(dir, { recursive: true })).map(String).sort();
    expect(left).toEqual([
      'New.request.yaml',
      'Old',
      'Old/.resources',
      'definition.yaml',
      'linked',
      'linked/Victim.request.yaml',
      'notes.txt',
    ]);
    expect(await fsp.readFile(path.join(outside, 'Victim.request.yaml'), 'utf8')).toBe('keep');
  });

  it('replace with the Bruno layout removes .bru files and bruno.json only', async () => {
    const target = path.join(tmpRoot, 'export-target');
    await fsp.mkdir(path.join(target, 'B'), { recursive: true });
    await fsp.writeFile(path.join(target, 'B', 'a.bru'), 'x');
    await fsp.writeFile(path.join(target, 'B', 'bruno.json'), '{}');
    await fsp.writeFile(path.join(target, 'B', 'keep.md'), 'x');
    const result = await saveBrunoEntriesToDirectory(target, [], {
      replace: { layout: 'bruno', subdir: 'B' },
    });
    expect(result.success).toBe(true);
    expect(await fsp.readdir(path.join(target, 'B'))).toEqual(['keep.md']);
  });

  it('the IPC handlers accept 2 or 3 args (an explicit undefined options arg included)', async () => {
    Object.assign(ipcMain, { removeHandler: vi.fn() });
    vi.mocked(ipcMain.handle).mockClear();
    registerBrunoExportHandlerIPC();
    const handlers = new Map(
      vi
        .mocked(ipcMain.handle)
        .mock.calls.map(([ch, fn]) => [ch, fn as (...a: unknown[]) => unknown])
    );
    const save = handlers.get('collection:save-bruno-directory');
    const inspect = handlers.get('collection:inspect-export-target');
    const target = path.join(tmpRoot, 'ipc-target');
    const entries = [{ relativePath: 'a.request.yaml', content: 'x' }];
    const event = {
      sender: { id: 1, isDestroyed: () => false },
      senderFrame: { url: 'file:///app/dist/web/index.html' },
    };
    for (const args of [
      [entries, target],
      [entries, target, undefined],
      [entries, target, {}],
    ]) {
      expect(await save?.(event, ...args)).toEqual({ success: true });
    }
    await expect(
      Promise.resolve(save?.(event, entries, target, { replace: { layout: 'x', subdir: 'a' } }))
    ).rejects.toThrow(/Invalid IPC payload/);
    expect(await inspect?.(event, tmpRoot, 'ipc-target')).toEqual({ exists: true, nonEmpty: true });
    disposeBrunoExportHandlerIPC();
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(2);
  });

  it('both channels are rate limited per sender', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    registerBrunoExportHandlerIPC();
    const inspect = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([ch]) => ch === 'collection:inspect-export-target')?.[1] as (
      ...a: unknown[]
    ) => Promise<unknown>;
    const event = {
      sender: { id: 4242, isDestroyed: () => false },
      senderFrame: { url: 'file:///app/dist/web/index.html' },
    };
    for (let i = 0; i < 60; i++) await inspect(event, tmpRoot, 'x');
    await expect(inspect(event, tmpRoot, 'x')).rejects.toThrow(/Rate limit exceeded/);
  });

  it('refuses a destination that is a directory, and a non-directory on the path', async () => {
    const target = path.join(tmpRoot, 'export-target');
    await fsp.mkdir(path.join(target, 'x.yaml'), { recursive: true });
    await fsp.writeFile(path.join(target, 'file'), 'x');
    expect(
      (await saveBrunoEntriesToDirectory(target, [{ relativePath: 'x.yaml', content: '' }])).success
    ).toBe(false);
    expect(
      (await saveBrunoEntriesToDirectory(target, [{ relativePath: 'file/y.yaml', content: '' }]))
        .success
    ).toBe(false);
  });
});

describe('safeSegments byte bound', () => {
  it('rejects a segment over 255 UTF-8 bytes even when under 255 UTF-16 units', () => {
    const seg = `${'漢'.repeat(100)}.request.yaml`;
    expect(seg.length).toBeLessThan(255);
    expect(() => safeSegments(seg)).toThrow(/too long/);
    expect(safeSegments(`${'漢'.repeat(80)}.request.yaml`)).toHaveLength(1);
  });
});
