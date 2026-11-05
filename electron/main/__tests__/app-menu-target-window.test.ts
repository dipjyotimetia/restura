import type { MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const focused = { current: null as unknown };
let captured: MenuItemConstructorOptions[] = [];

vi.mock('electron', () => ({
  app: { name: 'Restura', getVersion: () => '1', getPath: () => '/tmp' },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => focused.current },
  Menu: {
    buildFromTemplate: (t: MenuItemConstructorOptions[]) => {
      captured = t;
      return {};
    },
  },
}));

import { createApplicationMenu } from '../lifecycle/menu';

function makeWin(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } };
}

function click(label: string, win: unknown): void {
  const walk = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions | undefined => {
    for (const it of items) {
      if (it.label === label) return it;
      if (Array.isArray(it.submenu)) {
        const r = walk(it.submenu as MenuItemConstructorOptions[]);
        if (r) return r;
      }
    }
    return undefined;
  };
  const found = walk(captured);
  if (!found) throw new Error(`no item ${label}`);
  (found.click as (...a: unknown[]) => void)({}, win, {});
}

describe('application menu target window', () => {
  beforeEach(() => {
    focused.current = null;
    captured = [];
  });

  it('sends to the window the click came from, not the creation-time window', () => {
    const first = makeWin();
    const second = makeWin();
    createApplicationMenu(second as never);
    click('New Request', first);
    expect(first.webContents.send).toHaveBeenCalledWith('menu:new-request');
    expect(second.webContents.send).not.toHaveBeenCalled();
  });

  it('does not throw when the creation-time window was destroyed', () => {
    const dead = makeWin(true);
    const live = makeWin();
    focused.current = live;
    createApplicationMenu(dead as never);
    for (const label of ['New Request', 'Import Collection...', 'Export Collection...']) {
      expect(() => click(label, undefined)).not.toThrow();
    }
    expect(live.webContents.send).toHaveBeenCalledWith('menu:import');
  });

  it('is a no-op when no live window exists', () => {
    const dead = makeWin(true);
    createApplicationMenu(dead as never);
    expect(() => click('New Request', undefined)).not.toThrow();
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });
});
