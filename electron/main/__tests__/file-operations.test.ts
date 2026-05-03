// @vitest-environment node
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

import { isPathSafe } from '../file-operations';

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
