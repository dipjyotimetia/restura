// @vitest-environment node
import path from 'path';
import { vi } from 'vitest';

vi.mock('electron', () => {
  return {
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
      getVersion: vi.fn().mockReturnValue('1.0.0'),
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    BrowserWindow: class {
      loadURL = vi.fn();
      loadFile = vi.fn();
      on = vi.fn();
      webContents = { send: vi.fn() };
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
    },
    shell: {
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
  };
});

import { app } from 'electron';
import { isPathSafe } from '../storage/file-operations';

describe('isPathSafe', () => {
  it('path inside userData returns true', () => {
    expect(isPathSafe('/tmp/test-userData/myfile.json')).toBe(true);
  });

  it('path inside documents returns true', () => {
    expect(isPathSafe('/tmp/test-documents/project/data.json')).toBe(true);
  });

  it('path inside home returns true', () => {
    expect(isPathSafe('/tmp/test-home/projects/file.ts')).toBe(true);
  });

  it('exact root path returns true', () => {
    expect(isPathSafe('/tmp/test-userData')).toBe(true);
  });

  it('path outside allowed dirs returns false', () => {
    expect(isPathSafe('/tmp/random-dir/file.json')).toBe(false);
  });

  it('blocked system path /etc/passwd returns false', () => {
    expect(isPathSafe('/etc/passwd')).toBe(false);
  });

  it('blocked path /usr/bin/sh returns false', () => {
    expect(isPathSafe('/usr/bin/sh')).toBe(false);
  });

  it('Windows-style blocked path returns false', () => {
    expect(isPathSafe('C:\\Windows\\system32')).toBe(false);
  });

  it('path traversal attempt resolving to /etc/passwd returns false', () => {
    expect(isPathSafe('/tmp/test-userData/../../../etc/passwd')).toBe(false);
  });

  it('path traversal within allowed dir returns true', () => {
    expect(isPathSafe('/tmp/test-userData/sub/../file.json')).toBe(true);
  });

  it('prefix collision path returns false', () => {
    expect(isPathSafe('/tmp/test-userData-evil/file.json')).toBe(false);
  });

  it('empty string returns false', () => {
    expect(isPathSafe('')).toBe(false);
  });
});

describe('isPathSafe — tighter allowlist', () => {
  it('rejects ~/.ssh/id_rsa even though it sits under home', () => {
    const home = app.getPath('home');
    expect(isPathSafe(path.join(home, '.ssh', 'id_rsa'))).toBe(false);
  });

  it('rejects ~/.aws/credentials', () => {
    const home = app.getPath('home');
    expect(isPathSafe(path.join(home, '.aws', 'credentials'))).toBe(false);
  });

  it('rejects ~/.gnupg/private-keys-v1.d/abc.key', () => {
    const home = app.getPath('home');
    expect(isPathSafe(path.join(home, '.gnupg', 'private-keys-v1.d', 'abc.key'))).toBe(false);
  });

  it('rejects ~/.config/gh/hosts.yml', () => {
    const home = app.getPath('home');
    expect(isPathSafe(path.join(home, '.config', 'gh', 'hosts.yml'))).toBe(false);
  });

  it('allows files under userData', () => {
    const u = app.getPath('userData');
    expect(isPathSafe(path.join(u, 'collections', 'foo.json'))).toBe(true);
  });

  it('allows files under documents', () => {
    const d = app.getPath('documents');
    expect(isPathSafe(path.join(d, 'restura', 'foo.json'))).toBe(true);
  });

  it('rejects sibling-of-allowed-root prefix attacks', () => {
    const u = app.getPath('userData');
    expect(isPathSafe(u + '-evil/foo.json')).toBe(false);
  });

  it('allows ~/Documents/notes.json (non-blocked subdir under home)', () => {
    const home = app.getPath('home');
    // Documents is usually a separate allowed root; this path may exist under
    // home anyway. The point: not every subdir under $HOME is blocked.
    expect(isPathSafe(path.join(home, 'Downloads', 'foo.json'))).toBe(true);
  });
});
