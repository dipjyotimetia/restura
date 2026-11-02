// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ root: '', home: '', userData: '', documents: '' }));
const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => Promise<unknown>>());

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'home'
        ? paths.home
        : name === 'userData'
          ? paths.userData
          : name === 'documents'
            ? paths.documents
            : paths.root,
    getVersion: () => '1.0.0',
  },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => Promise<unknown>) => handlers.set(ch, fn),
    on: vi.fn(),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: vi.fn(),
}));

import {
  hasUnsafeWin32Components,
  isPathRealSafe,
  isPathSafe,
  registerFileOperationsIPC,
} from '../../electron/main/storage/file-operations';

const trusted = { sender: { id: 1 }, senderFrame: { url: 'file:///app/dist/web/index.html' } };
const read = (p: string) =>
  handlers.get('fs:readFile')?.(trusted, p) as Promise<{ success: boolean; content?: string }>;
const write = (p: string, c = 'x') =>
  handlers.get('fs:writeFile')?.(trusted, [p, c]) as Promise<{ success: boolean; error?: string }>;

beforeAll(() => {
  paths.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restura-fswp-')));
  paths.home = path.join(paths.root, 'home');
  paths.userData = path.join(paths.root, 'userData');
  paths.documents = path.join(paths.home, 'Documents');
  for (const d of [paths.home, paths.userData, paths.documents]) {
    fs.mkdirSync(d, { recursive: true });
  }
  registerFileOperationsIPC(() => null);
});
afterAll(() => fs.rmSync(paths.root, { recursive: true, force: true }));

describe('home write policy: login-time launch locations', () => {
  const blocked = [
    '.zprofile',
    '.zlogin',
    '.zlogout',
    '.bash_login',
    '.bash_logout',
    '.profile',
    '.inputrc',
    '.xprofile',
    '.xsessionrc',
    'Library/LaunchAgents/x.plist',
    '.config/autostart/x.desktop',
    '.config/systemd/user/x.service',
    '.config/environment.d/x.conf',
    '.config/fish/config.fish',
    '.local/share/applications/x.desktop',
    // case-insensitive volumes
    '.ZProfile',
    'library/launchagents/x.plist',
  ];
  it.each(blocked)('isPathSafe refuses ~/%s', (rel) => {
    expect(isPathSafe(path.join(paths.home, rel))).toBe(false);
  });

  it('does not match by substring or sibling prefix', () => {
    expect(isPathSafe(path.join(paths.home, '.zprofile-notes', 'a.json'))).toBe(true);
    expect(isPathSafe(path.join(paths.home, 'my.zprofile.json'))).toBe(true);
    expect(isPathSafe(path.join(paths.home, '.config/fishing/a.json'))).toBe(true);
  });

  it('keeps legitimate paths allowed', async () => {
    expect(isPathSafe(path.join(paths.documents, 'restura', 'collection.json'))).toBe(true);
    expect(isPathSafe(path.join(paths.home, 'projects', 'my-collection', 'req.json'))).toBe(true);
    const file = path.join(paths.documents, 'restura', 'collection.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await expect(write(file)).resolves.toEqual({ success: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
  });
});

describe('fs:writeFile symlink handling', () => {
  it('refuses a dir symlink inside an allowed dir pointing into a blocked dir', async () => {
    const target = path.join(paths.home, 'Library', 'LaunchAgents');
    fs.mkdirSync(target, { recursive: true });
    const link = path.join(paths.documents, 'agents-link');
    fs.symlinkSync(target, link);
    expect(await isPathRealSafe(path.join(link, 'x.plist'))).toBe(false);
    const res = await write(path.join(link, 'x.plist'), '<plist/>');
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(target, 'x.plist'))).toBe(false);
  });

  it('refuses a dangling file symlink to a blocked file', async () => {
    const link = path.join(paths.documents, 'profile-link');
    fs.symlinkSync(path.join(paths.home, '.zprofile'), link);
    const res = await write(link, 'evil');
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(paths.home, '.zprofile'))).toBe(false);
  });

  it('refuses a symlink escaping the allowed roots', async () => {
    const outside = path.join(paths.root, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(paths.documents, 'out-link');
    fs.symlinkSync(outside, link);
    expect((await write(path.join(link, 'a.json'))).success).toBe(false);
  });
});

describe('dot-dot after symlink, unicode, win32 quirks, reads', () => {
  it('refuses link/../ traversal that the kernel would resolve through the symlink', async () => {
    const cloud = path.join(paths.home, 'Library', 'CloudStorage', 'X');
    fs.mkdirSync(cloud, { recursive: true });
    fs.mkdirSync(path.join(paths.home, 'Library', 'LaunchAgents'), { recursive: true });
    const proj = path.join(paths.documents, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.symlinkSync(cloud, path.join(proj, 'cloud'));
    const sneaky = `${proj}/cloud/../../LaunchAgents/evil.plist`;
    await expect(write(sneaky, 'evil')).rejects.toThrow(/\.\./);
    expect(fs.existsSync(path.join(paths.home, 'Library', 'LaunchAgents', 'evil.plist'))).toBe(
      false
    );
    await expect(write('relative/file.json')).rejects.toThrow();
  });

  it('folds unicode compatibility characters (U+017F) in denylist matching', () => {
    expect(isPathSafe(path.join(paths.home, 'Library', 'LaunchAgent\u017F', 'x.plist'))).toBe(
      false
    );
    expect(isPathSafe(path.join(paths.home, '.\u017Fh' + 'ell'))).toBe(true);
    expect(isPathSafe(path.join(paths.home, '.config', 'AUTOSTART', 'x.desktop'))).toBe(false);
  });

  it('flags win32 trailing dot/space components and ADS', () => {
    expect(hasUnsafeWin32Components('C:\\Users\\a\\.zprofile.')).toBe(true);
    expect(hasUnsafeWin32Components('C:\\Users\\a\\Library \\x')).toBe(true);
    expect(hasUnsafeWin32Components('C:\\Users\\a\\f.txt:stream')).toBe(true);
    expect(hasUnsafeWin32Components('C:\\Users\\a\\Documents\\f.json')).toBe(false);
  });

  it('refuses reads through a symlink into ~/.ssh and `..` reads, allows normal reads', async () => {
    const ssh = path.join(paths.home, '.ssh');
    fs.mkdirSync(ssh, { recursive: true });
    fs.writeFileSync(path.join(ssh, 'id_rsa'), 'SECRET');
    const link = path.join(paths.documents, 'ssh-link');
    fs.symlinkSync(ssh, link);
    expect((await read(path.join(link, 'id_rsa'))).success).toBe(false);
    await expect(read(`${paths.documents}/proj/../ssh-link/id_rsa`)).rejects.toThrow(/\.\./);
    const ok = path.join(paths.documents, 'ok.json');
    fs.writeFileSync(ok, '{}');
    await expect(read(ok)).resolves.toEqual({ success: true, content: '{}' });
  });
});
