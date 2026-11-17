// @vitest-environment node
/**
 * #1353: a missing optional native (`@modelcontextprotocol/node`) used to throw
 * while the main process was still loading, before any window existed. The
 * feature loader has to contain that, and the window still has to open.
 *
 * This is not the mocked `startFeatures` case in startup-resilience.test.ts.
 * Node's resolver is blocked for that one package, then the real desktop
 * feature list and `createMainWindow` run.
 */
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { consoleSink, noopSink, setLogSink } from '@shared/runtime/logger';
import { afterAll, describe, expect, it, vi } from 'vitest';

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const openedWindows = vi.hoisted(() => [] as FakeWindow[]);

interface FakeContents {
  id: number;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  once: (event: string, cb: (...args: unknown[]) => void) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  openDevTools: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

class FakeWindow {
  destroyed = false;
  webContents: FakeContents;
  constructor(_opts: unknown) {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const add = (event: string, cb: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    };
    this.webContents = {
      id: openedWindows.length + 1,
      listeners,
      once: add,
      on: add,
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn(),
      reload: vi.fn(),
      send: vi.fn(),
    };
    openedWindows.push(this);
  }
  on() {
    return this;
  }
  once() {
    return this;
  }
  loadFile = vi.fn();
  loadURL = vi.fn();
  isDestroyed() {
    return this.destroyed;
  }
  maximize() {}
  show() {}
  getBounds() {
    return { x: 0, y: 0, width: 1400, height: 900 };
  }
  isMaximized() {
    return false;
  }
  static getAllWindows() {
    return openedWindows.filter((w) => !w.destroyed);
  }
  static getFocusedWindow() {
    return null;
  }
}

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    getName: () => 'Restura',
    isPackaged: false,
    exit: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
    requestSingleInstanceLock: () => true,
  },
  BrowserWindow: FakeWindow,
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel);
    },
    on: vi.fn(),
  },
  Menu: {
    buildFromTemplate: () => ({ items: [] }),
    setApplicationMenu: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn(), readText: () => '' },
  nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  Notification: Object.assign(function Notification() {}, { isSupported: () => false }),
  Tray: class {},
  ClipboardItem: class {},
  webContents: { fromId: () => undefined },
  session: { defaultSession: {} },
}));

const BLOCKED = '@modelcontextprotocol/node';

type ResolveFilename = (
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean,
  options?: Record<string, unknown>
) => string;

const moduleApi = Module as unknown as { _resolveFilename: ResolveFilename };
const originalResolve = moduleApi._resolveFilename;

function isBlockedSpecifier(request: string): boolean {
  return request === BLOCKED || request.startsWith(`${BLOCKED}/`);
}

function installBlock(): void {
  moduleApi._resolveFilename = function (request, parent, isMain, options) {
    if (isBlockedSpecifier(request)) {
      const err = new Error(`Cannot find module '${request}'`) as NodeJS.ErrnoException;
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
}

afterAll(() => {
  moduleApi._resolveFilename = originalResolve;
  setLogSink(consoleSink);
});

describe('startup with @modelcontextprotocol/node blocked', () => {
  it('still registers the rest of the app and opens a window', async () => {
    setLogSink(noopSink);
    installBlock();
    const nodeRequire = createRequire(import.meta.url);
    expect(() => nodeRequire(BLOCKED)).toThrow(/Cannot find module '@modelcontextprotocol\/node'/);

    const { createDesktopFeatures } = await import('../lifecycle/ipc-features');
    const { startFeatures } = await import('../lifecycle/feature-loader');
    const { createMainWindow } = await import('../window-manager');
    const { startControlHttpServer, __setMcpNodeAdapterLoaderForTests } = await import(
      '../handlers/mcp-control-server'
    );
    __setMcpNodeAdapterLoaderForTests(undefined);

    const failures: { feature: string; message: string }[] = [];
    const features = createDesktopFeatures({
      isDev: false,
      getMainWindow: () => null,
      logRequest: () => {},
    });
    // The real feature list plus a start() that hits the blocked package the
    // way a top-level `require('@modelcontextprotocol/node')` did in #1353.
    // Later features must still run, and the window must still open.
    let laterRan = false;
    features.push(
      {
        name: 'mcp-node-adapter',
        start: () => {
          nodeRequire(BLOCKED);
        },
      },
      {
        name: 'after-blocked-native',
        start: () => {
          laterRan = true;
        },
      }
    );
    const running = startFeatures(features, (failure) => {
      failures.push(failure);
    });

    const win = createMainWindow(false);
    expect(win).toBe(openedWindows[0]);
    expect(openedWindows[0]?.loadFile).toHaveBeenCalled();
    expect(running.length + failures.length).toBe(features.length);
    expect(laterRan).toBe(true);
    expect(failures.map((failure) => failure.feature)).toContain('mcp-node-adapter');
    expect(failures.find((failure) => failure.feature === 'mcp-node-adapter')?.message).toMatch(
      /Cannot find module '@modelcontextprotocol\/node'/
    );

    // The production lazy loader, not the test seam, must fail closed.
    __setMcpNodeAdapterLoaderForTests(undefined);
    await expect(
      startControlHttpServer({
        identity: { name: 'restura', version: '0.0.0-test' },
        getToken: () => 't'.repeat(43),
        dispatch: async () => ({ ok: true, data: null }),
      })
    ).rejects.toThrow(/@modelcontextprotocol\/node/);
    expect(openedWindows).toHaveLength(1);
  }, 60_000);
});
