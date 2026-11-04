// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grantCollectionRoot,
  isPathRealSafe,
  isPathSafe,
  resetGrantedCollectionRootsForTests,
} from '../storage/file-operations';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      switch (name) {
        case 'userData':
          return '/tmp/test-userData';
        case 'documents':
          return '/tmp/test-documents';
        case 'home':
          return '/tmp/test-home';
        default:
          return '/tmp/test-other';
      }
    }),
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {},
}));

const defaultGetPath = vi.mocked(app.getPath).getMockImplementation();

function withPaths(paths: Record<string, string>) {
  vi.mocked(app.getPath).mockImplementation(
    ((name: string) => paths[name] ?? '/tmp/test-other') as never
  );
}

afterEach(() => {
  if (defaultGetPath) vi.mocked(app.getPath).mockImplementation(defaultGetPath);
  resetGrantedCollectionRootsForTests();
});

describe('isPathSafe — root denylist boundaries', () => {
  it('does not deny everything under a HOME of /root', () => {
    withPaths({ home: '/root', userData: '/root/.config/Restura', documents: '/root/Documents' });
    expect(isPathSafe('/root/projects/api/opencollection.yml')).toBe(true);
    expect(isPathSafe('/root/.ssh/id_rsa')).toBe(false);
  });

  it('does not block siblings that merely share a denylist prefix', () => {
    withPaths({
      home: '/binfoo/user',
      userData: '/binfoo/user/ud',
      documents: '/binfoo/user/Docs',
    });
    expect(isPathSafe('/binfoo/user/work/a.json')).toBe(true);
  });

  it('still denies the root itself and children', () => {
    expect(isPathSafe('/etc')).toBe(false);
    expect(isPathSafe('/etc/hosts')).toBe(false);
    expect(isPathSafe('/var/lib/x')).toBe(false);
  });

  it('allows userData on macOS even though Library/Application Support is denylisted', () => {
    const ud = '/tmp/test-home/Library/Application Support/Restura';
    withPaths({ home: '/tmp/test-home', userData: ud, documents: '/tmp/test-documents' });
    expect(isPathSafe(`${ud}/collections/a/opencollection.yml`)).toBe(true);
    expect(isPathSafe('/tmp/test-home/Library/Application Support/Other/x')).toBe(false);
    expect(isPathSafe(`${ud}/restura-vault.json`)).toBe(false);
  });
});

describe('dialog-granted collection roots', () => {
  let base: string;
  let userData: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'restura-grant-'));
    userData = path.join(base, 'ud');
    outside = path.join(base, 'work');
    await mkdir(userData, { recursive: true });
    await mkdir(outside, { recursive: true });
    withPaths({ userData, home: '/tmp/test-home', documents: '/tmp/test-documents' });
    resetGrantedCollectionRootsForTests();
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('rejects a folder outside the default roots until granted via the dialog', async () => {
    const target = path.join(outside, 'api');
    await mkdir(target);
    expect(await isPathRealSafe(target)).toBe(false);
    expect(await grantCollectionRoot(outside)).toBe(true);
    expect(isPathSafe(target)).toBe(true);
    expect(await isPathRealSafe(target)).toBe(true);
    expect(isPathSafe(`${outside}-evil/x`)).toBe(false);
  });

  it('survives a restart (persisted)', async () => {
    await grantCollectionRoot(outside);
    resetGrantedCollectionRootsForTests();
    expect(isPathSafe(path.join(outside, 'api'))).toBe(true);
  });

  it('refuses to grant system roots', async () => {
    expect(await grantCollectionRoot('/etc')).toBe(false);
    expect(await grantCollectionRoot('/usr/local')).toBe(false);
    expect(isPathSafe('/etc/passwd')).toBe(false);
  });

  it('refuses to grant credential directories under home', async () => {
    expect(await grantCollectionRoot('/tmp/test-home/.ssh')).toBe(false);
  });

  it('does not let a granted root expose main-owned userData state', async () => {
    expect(await grantCollectionRoot(userData)).toBe(true);
    expect(isPathSafe(path.join(userData, 'restura-collection-roots.json'))).toBe(false);
  });
});
