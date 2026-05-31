import { vi } from 'vitest';

vi.mock('electron', () => {
  const getPath = vi.fn((name: string) => {
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
  });

  const webContents = {
    send: vi.fn(),
  };

  class BrowserWindowMock {
    loadURL = vi.fn();
    loadFile = vi.fn();
    on = vi.fn();
    webContents = webContents;
  }

  return {
    app: {
      getPath,
      getVersion: vi.fn().mockReturnValue('1.0.0'),
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    BrowserWindow: BrowserWindowMock,
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
      isAsyncEncryptionAvailable: vi.fn(),
      encryptStringAsync: vi.fn(),
      decryptStringAsync: vi.fn(),
    },
  };
});
