// Shared Electron mock for main-process unit tests.
//
// Before this helper, every handler test inlined its own `vi.mock('electron')`
// (28+ copies, all subtly different). New tests should use this instead.
//
// Usage — mock the module, then inspect/configure the singleton mock fns:
//
//   import { vi } from 'vitest';
//   import { trustedEvent, getRegisteredHandler } from './helpers/electron-mock';
//
//   // The factory must `await import` the helper: Vitest hoists `vi.mock` above
//   // the static imports, so the factory cannot reference an imported binding
//   // directly — but an async factory may import it lazily.
//   vi.mock('electron', async () => {
//     const { createElectronMock } = await import('./helpers/electron-mock');
//     return createElectronMock();
//   });
//
//   import { ipcMain } from 'electron';
//   const handler = getRegisteredHandler(ipcMain, 'sse:connect');
//   await handler(trustedEvent(), { connectionId: 'c1', url: 'https://x' });
//
// To configure a mock (e.g. a dialog result):
//   import { dialog } from 'electron';
//   vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: ['/a'] });

import { vi } from 'vitest';

/** Minimal shape of the mocked `webContents` instances handlers receive. */
export interface MockWebContents {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

/**
 * Factory for `vi.mock('../../../src/lib/shared/logger', silenceLogger)` — keeps
 * the real module's exports but swaps `createLogger` for a no-op so handler
 * tests don't spew JSON log lines (which also choke the CI issue-matcher).
 */
export async function silenceLogger(
  importOriginal: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
}

/** A fake `webContents` for streaming-handler emit/cleanup assertions. */
export function fakeWebContents(id = 1): MockWebContents {
  return {
    id,
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    on: vi.fn(),
  };
}

/**
 * Build a valid `IpcMainInvokeEvent`. `senderFrame.url` is a `file:///` URL so
 * it passes `assertTrustedSender` (the packaged renderer loads over file://).
 */
export function trustedEvent(senderId = 1): Electron.IpcMainInvokeEvent {
  return {
    sender: { id: senderId, isDestroyed: () => false, send: vi.fn() },
    senderFrame: { url: 'file:///app/dist/web/index.html' },
  } as unknown as Electron.IpcMainInvokeEvent;
}

/** An event from an untrusted (non-file://) frame — should be rejected. */
export function untrustedEvent(senderId = 1): Electron.IpcMainInvokeEvent {
  return {
    sender: { id: senderId, isDestroyed: () => false, send: vi.fn() },
    senderFrame: { url: 'https://attacker.example' },
  } as unknown as Electron.IpcMainInvokeEvent;
}

interface IpcMainLike {
  handle: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

type AnyHandler = (...args: unknown[]) => unknown;

/** Pull a handler registered via `ipcMain.handle(channel, fn)` out of the mock. */
export function getRegisteredHandler(ipcMain: unknown, channel: string): AnyHandler {
  const handle = (ipcMain as IpcMainLike).handle;
  const call = handle.mock.calls.find((c) => c[0] === channel);
  if (!call) {
    throw new Error(`No ipcMain.handle registered for channel "${channel}"`);
  }
  return call[1] as AnyHandler;
}

/** Pull a listener registered via `ipcMain.on(channel, fn)` out of the mock. */
export function getRegisteredListener(ipcMain: unknown, channel: string): AnyHandler {
  const on = (ipcMain as IpcMainLike).on;
  const call = on.mock.calls.find((c) => c[0] === channel);
  if (!call) {
    throw new Error(`No ipcMain.on registered for channel "${channel}"`);
  }
  return call[1] as AnyHandler;
}

/**
 * Factory returning a `vi.mock('electron')` module object. Pass `overrides` to
 * replace or extend any top-level export (e.g. a custom `safeStorage`).
 */
export function createElectronMock(overrides: Record<string, unknown> = {}) {
  const sharedWebContents = fakeWebContents(1);

  const getPath = vi.fn((name: string) => {
    switch (name) {
      case 'userData':
        return '/tmp/test-userData';
      case 'documents':
        return '/tmp/test-documents';
      case 'home':
        return '/tmp/test-home';
      case 'logs':
        return '/tmp/test-logs';
      default:
        return '/tmp/test-other';
    }
  });

  class BrowserWindowMock {
    static getAllWindows = vi.fn(() => [] as BrowserWindowMock[]);
    static getFocusedWindow = vi.fn(() => null);
    loadURL = vi.fn();
    loadFile = vi.fn();
    on = vi.fn();
    once = vi.fn();
    show = vi.fn();
    hide = vi.fn();
    focus = vi.fn();
    isDestroyed = vi.fn(() => false);
    webContents = sharedWebContents;
  }

  class TrayMock {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
    destroy = vi.fn();
  }

  const module = {
    app: {
      getPath,
      getAppPath: vi.fn(() => '/app'),
      getVersion: vi.fn(() => '1.0.0'),
      getName: vi.fn(() => 'Restura'),
      quit: vi.fn(),
      on: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      requestSingleInstanceLock: vi.fn(() => true),
      isPackaged: false,
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    BrowserWindow: BrowserWindowMock,
    Tray: TrayMock,
    Menu: {
      buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
      setApplicationMenu: vi.fn(),
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(() => Promise.resolve()),
      showItemInFolder: vi.fn(),
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((s: string) => Buffer.from(s)),
      decryptString: vi.fn((b: Buffer) => b.toString()),
    },
    nativeImage: {
      createFromPath: vi.fn(() => ({ isEmpty: () => false, resize: vi.fn() })),
      createEmpty: vi.fn(() => ({ isEmpty: () => true })),
    },
    webContents: {
      fromId: vi.fn(() => sharedWebContents),
      getAllWebContents: vi.fn(() => [sharedWebContents]),
    },
    ...overrides,
  };

  return module;
}
