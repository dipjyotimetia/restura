// @vitest-environment node
//
// Pure helpers from window-manager: active-window selection, window-state
// load/save (with corruption-resilient validation), and resource/icon path
// resolution. BrowserWindow construction (createMainWindow) is integration-only
// and covered by the _electron launch harness.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fsMock } = vi.hoisted(() => ({
  fsMock: {
    existsSync: vi.fn((_p: string) => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

import { createElectronMock, silenceLogger } from './helpers/electron-mock';

vi.mock('electron', () => createElectronMock());
vi.mock('fs', () => fsMock);
vi.mock('../../../src/lib/shared/logger', (orig) => silenceLogger(orig));

import { BrowserWindow } from 'electron';
import {
  getActiveWindow,
  getWindowStatePath,
  loadWindowState,
  saveWindowState,
  getResourcePath,
  getIconPath,
} from '../window-manager';

const live = (over: Record<string, unknown> = {}) =>
  ({ isDestroyed: () => false, ...over }) as never;

describe('getActiveWindow', () => {
  beforeEach(() => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReset();
    vi.mocked(BrowserWindow.getAllWindows).mockReset().mockReturnValue([]);
  });

  it('returns the focused window when one is live', () => {
    const win = live();
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(win);
    expect(getActiveWindow()).toBe(win);
  });

  it('falls back to the first live window when none is focused', () => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null);
    const dead = live({ isDestroyed: () => true });
    const alive = live();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([dead, alive]);
    expect(getActiveWindow()).toBe(alive);
  });

  it('returns null when there are no live windows', () => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null);
    expect(getActiveWindow()).toBeNull();
  });
});

describe('window state', () => {
  beforeEach(() => {
    Object.values(fsMock).forEach((f) => f.mockReset());
    fsMock.existsSync.mockReturnValue(false);
  });

  it('getWindowStatePath joins userData', () => {
    expect(getWindowStatePath()).toContain('window-state.json');
  });

  it('returns defaults when no state file exists', () => {
    expect(loadWindowState()).toMatchObject({ width: 1400, height: 900, isMaximized: false });
  });

  it('merges a valid persisted state over the defaults', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ width: 800, height: 600, isMaximized: true })
    );
    expect(loadWindowState()).toMatchObject({ width: 800, height: 600, isMaximized: true });
  });

  it('falls back to defaults on corrupt JSON', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('{ not json');
    expect(loadWindowState()).toMatchObject({ width: 1400, height: 900 });
  });

  it('falls back to defaults on schema-invalid state', () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ width: 'wide', isMaximized: 'yes' }));
    expect(loadWindowState()).toMatchObject({ width: 1400, height: 900 });
  });

  it('saveWindowState writes the current bounds and maximized flag', () => {
    const win = {
      getBounds: () => ({ width: 1024, height: 768, x: 10, y: 20 }),
      isMaximized: () => true,
    };
    saveWindowState(win as never);
    const [, json] = fsMock.writeFileSync.mock.calls[0]!;
    expect(JSON.parse(json as string)).toEqual({
      width: 1024,
      height: 768,
      x: 10,
      y: 20,
      isMaximized: true,
    });
  });
});

describe('resource paths', () => {
  beforeEach(() => {
    Object.values(fsMock).forEach((f) => f.mockReset());
    fsMock.existsSync.mockReturnValue(false);
  });

  it('getResourcePath differs between dev and prod roots', () => {
    expect(getResourcePath('icon.png', true)).toContain('electron/resources/icon.png');
    expect(getResourcePath('icon.png', false)).toContain('/app/electron/resources/icon.png');
  });

  it('getIconPath returns the png when it exists', () => {
    fsMock.existsSync.mockImplementation((p: string) => p.endsWith('icon.png'));
    expect(getIconPath(true)).toMatch(/icon\.png$/);
  });

  it('getIconPath returns undefined when no icon exists', () => {
    fsMock.existsSync.mockReturnValue(false);
    expect(getIconPath(true)).toBeUndefined();
  });
});
