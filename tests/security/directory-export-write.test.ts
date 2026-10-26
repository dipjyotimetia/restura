// @vitest-environment node
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Directory export (Bruno `.bru`, Postman v3 folder) writes renderer-supplied
 * relative paths under a user-picked directory. Lexical containment is not
 * enough: planted symlinks (a file or an intermediate directory) must never be
 * followed, every destination must pass the $HOME denylist, and the request
 * is capped in size / count.
 */

const h = vi.hoisted(() => ({ home: '', userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === 'home' ? h.home : name === 'userData' ? h.userData : '/tmp/restura-no-docs'
    ),
  },
  ipcMain: { handle: vi.fn() },
}));

import {
  DIRECTORY_EXPORT_LIMITS,
  inspectExportTarget,
  saveBrunoEntriesToDirectory,
} from '../../electron/main/storage/bruno-export-handler';

let root = '';

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join('/tmp', 'dir-export-sec-'));
  h.home = path.join(root, 'home');
  h.userData = path.join(root, 'userdata');
  await fsp.mkdir(h.home, { recursive: true });
  await fsp.mkdir(h.userData, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('directory export — symlinks are never followed', () => {
  it('refuses to overwrite through a planted file symlink', async () => {
    const victim = path.join(h.home, '.zshrc');
    await fsp.writeFile(victim, 'export TOKEN=keep');
    const target = path.join(h.home, 'exports');
    await fsp.mkdir(path.join(target, 'API'), { recursive: true });
    await fsp.symlink(victim, path.join(target, 'API', 'X.request.yaml'));
    const result = await saveBrunoEntriesToDirectory(target, [
      { relativePath: 'API/X.request.yaml', content: 'pwned' },
    ]);
    expect(result.success).toBe(false);
    expect(await fsp.readFile(victim, 'utf8')).toBe('export TOKEN=keep');
  });

  it('refuses a symlinked intermediate directory (.resources → elsewhere)', async () => {
    const outside = path.join(h.home, 'outside');
    await fsp.mkdir(outside);
    const target = path.join(h.home, 'exports');
    await fsp.mkdir(path.join(target, 'API'), { recursive: true });
    await fsp.symlink(outside, path.join(target, 'API', '.resources'));
    const result = await saveBrunoEntriesToDirectory(target, [
      { relativePath: 'API/.resources/definition.yaml', content: 'x' },
    ]);
    expect(result.success).toBe(false);
    expect(await fsp.readdir(outside)).toEqual([]);
  });

  it('refuses a symlinked target root', async () => {
    const outside = path.join(root, 'elsewhere');
    await fsp.mkdir(outside);
    const link = path.join(h.home, 'exports');
    await fsp.symlink(outside, link);
    const result = await saveBrunoEntriesToDirectory(link, [
      { relativePath: 'a.request.yaml', content: 'x' },
    ]);
    expect(result.success).toBe(false);
    expect(await fsp.readdir(outside)).toEqual([]);
  });
});

describe('directory export — destination policy and caps', () => {
  it('picking ~ with a "Library" collection cannot write into ~/Library/Keychains', async () => {
    const result = await saveBrunoEntriesToDirectory(h.home, [
      { relativePath: 'Library/Keychains/login.request.yaml', content: 'x' },
    ]);
    expect(result.success).toBe(false);
    await expect(fsp.access(path.join(h.home, 'Library'))).rejects.toThrow();
  });

  it('rejects unsafe path segments (NUL, control chars, reserved names, dot segments)', async () => {
    const target = path.join(h.home, 'exports');
    for (const relativePath of [
      'a\u0000b.yaml',
      'a\u0007/b.yaml',
      'CON/x.yaml',
      'nul.txt',
      './a/../b',
      'a//b',
    ]) {
      const result = await saveBrunoEntriesToDirectory(target, [{ relativePath, content: 'x' }]);
      expect(result.success, relativePath).toBe(false);
    }
  });

  it('caps file count and total bytes before writing anything', async () => {
    const target = path.join(h.home, 'exports');
    const many = Array.from({ length: DIRECTORY_EXPORT_LIMITS.maxFiles + 1 }, (_, i) => ({
      relativePath: `f${i}.yaml`,
      content: '',
    }));
    expect((await saveBrunoEntriesToDirectory(target, many)).error).toMatch(/too many files/);
    const big = 'x'.repeat(Math.ceil(DIRECTORY_EXPORT_LIMITS.maxTotalBytes / 3) + 1);
    const heavy = [0, 1, 2].map((i) => ({ relativePath: `b${i}.yaml`, content: big }));
    expect((await saveBrunoEntriesToDirectory(target, heavy)).error).toMatch(/too large/);
    await expect(fsp.access(target)).rejects.toThrow();
  });

  it('inspectExportTarget never reports through a symlink and rejects unsafe child names', async () => {
    const target = path.join(h.home, 'exports');
    await fsp.mkdir(path.join(target, 'API'), { recursive: true });
    await fsp.writeFile(path.join(target, 'API', 'a.request.yaml'), 'x');
    expect(await inspectExportTarget(target, 'API')).toEqual({ exists: true, nonEmpty: true });
    expect(await inspectExportTarget(target, 'New')).toEqual({ exists: false, nonEmpty: false });
    await expect(inspectExportTarget(target, '../x')).rejects.toThrow();
    await expect(inspectExportTarget('/etc', 'x')).rejects.toThrow();
  });
});
