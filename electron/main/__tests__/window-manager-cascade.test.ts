// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/x'), name: 'Restura' },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
  Menu: {},
  shell: {},
}));

import { cascadePosition, shouldPersistWindowState } from '../window-manager';

describe('multi-window placement', () => {
  it('opens the first window at the saved position', () => {
    expect(cascadePosition({ x: 100, y: 80 }, null)).toEqual({ x: 100, y: 80 });
  });

  it('offsets a new window from an existing one instead of stacking exactly on top', () => {
    const pos = cascadePosition({ x: 100, y: 80 }, { x: 100, y: 80 });
    expect(pos.x).toBeGreaterThan(100);
    expect(pos.y).toBeGreaterThan(80);
  });

  it('cascades from the reference window even when no saved position exists', () => {
    expect(cascadePosition({}, { x: 10, y: 20 })).toEqual({ x: 40, y: 50 });
  });

  it('persists state only from the last remaining window', () => {
    expect(shouldPersistWindowState(0)).toBe(true);
    expect(shouldPersistWindowState(1)).toBe(false);
  });
});
