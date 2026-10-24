// @vitest-environment node
import { vi } from 'vitest';

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
    getVersion: vi.fn().mockReturnValue('1.0.0'),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  BrowserWindow: vi.fn(),
}));

import { describe, expect, it } from 'vitest';
import { isPathSafe } from '../../electron/main/storage/file-operations';

describe('isPathSafe', () => {
  it('path traversal ../../etc/passwd relative to allowed dir is blocked', () => {
    expect(isPathSafe('/tmp/test-userData/../../etc/passwd')).toBe(false);
  });

  it('/tmp/test-userData/../../../etc/shadow traverses out and is blocked', () => {
    expect(isPathSafe('/tmp/test-userData/../../../etc/shadow')).toBe(false);
  });

  it('/tmp/test-userData/sub/../../file.json resolves to /tmp/file.json (outside allowed) and is blocked', () => {
    expect(isPathSafe('/tmp/test-userData/sub/../../file.json')).toBe(false);
  });

  it('/tmp/test-userData/sub/../data/file.json stays inside userData and is allowed', () => {
    expect(isPathSafe('/tmp/test-userData/sub/../data/file.json')).toBe(true);
  });

  it('a traversal that lands on a main-owned store file at the userData root is blocked', () => {
    expect(isPathSafe('/tmp/test-userData/sub/../file.json')).toBe(false);
    expect(isPathSafe('/tmp/test-userData/sub/../restura-mcp-stdio-consent.json')).toBe(false);
    expect(isPathSafe('/tmp/test-userData/sub/../.mcp-stdio-consent-key')).toBe(false);
  });

  it('/tmp/test-documents/../test-userData-evil/file.json traverses to non-allowed path and is blocked', () => {
    expect(isPathSafe('/tmp/test-documents/../test-userData-evil/file.json')).toBe(false);
  });

  it('path with null bytes does not crash and returns a boolean', () => {
    const result = isPathSafe('/tmp/test-userData/file\x00.json');
    expect(typeof result).toBe('boolean');
  });
});
