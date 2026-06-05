// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createElectronMock,
  trustedEvent,
  untrustedEvent,
  getRegisteredListener,
  silenceLogger,
} from './helpers/electron-mock';

vi.mock('electron', () => createElectronMock());
vi.mock('../../../src/lib/shared/logger', (orig) => silenceLogger(orig));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import { registerWindowControlsIPC } from '../window-controls';

function fakeWindow() {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => false),
  };
}

describe('window-controls', () => {
  let win: ReturnType<typeof fakeWindow>;

  beforeEach(() => {
    vi.mocked(ipcMain.on).mockClear();
    win = fakeWindow();
    registerWindowControlsIPC(() => win as never);
  });

  it('registers minimize / maximize / close listeners', () => {
    const channels = vi.mocked(ipcMain.on).mock.calls.map((c) => c[0]);
    expect(channels).toEqual(
      expect.arrayContaining([IPC.window.minimize, IPC.window.maximize, IPC.window.close])
    );
  });

  it('minimizes the window for a trusted sender', () => {
    getRegisteredListener(ipcMain, IPC.window.minimize)(trustedEvent());
    expect(win.minimize).toHaveBeenCalled();
  });

  it('ignores a control message from an untrusted frame', () => {
    getRegisteredListener(ipcMain, IPC.window.close)(untrustedEvent());
    expect(win.close).not.toHaveBeenCalled();
  });

  it('maximizes when not maximized and unmaximizes when already maximized', () => {
    const maximize = getRegisteredListener(ipcMain, IPC.window.maximize);

    win.isMaximized.mockReturnValue(false);
    maximize(trustedEvent());
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.unmaximize).not.toHaveBeenCalled();

    win.isMaximized.mockReturnValue(true);
    maximize(trustedEvent());
    expect(win.unmaximize).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when there is no main window', () => {
    vi.mocked(ipcMain.on).mockClear();
    registerWindowControlsIPC(() => null);
    expect(() => getRegisteredListener(ipcMain, IPC.window.minimize)(trustedEvent())).not.toThrow();
  });
});
