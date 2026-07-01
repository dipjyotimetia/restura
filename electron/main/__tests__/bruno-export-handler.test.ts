// @vitest-environment node
import * as fsp from 'fs/promises';
import * as path from 'path';
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

import { saveBrunoEntriesToDirectory } from '../storage/bruno-export-handler';

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
    expect(result.error).toMatch(/outside target directory/);

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
});
