// @vitest-environment node
//
// Smoke coverage for the application menu and system tray: they build from
// templates and wire click handlers to renderer IPC events. We mock Menu/Tray
// and assert the template is built and the click handlers fire the right
// channels (and no-op on a destroyed window).
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createElectronMock, silenceLogger } from './helpers/electron-mock';

const { builtTemplates } = vi.hoisted(() => ({ builtTemplates: [] as unknown[][] }));

vi.mock('electron', () =>
  createElectronMock({
    nativeImage: {
      createFromPath: vi.fn(() => ({
        isEmpty: () => false,
        setTemplateImage: vi.fn(),
        resize: vi.fn(() => ({})),
      })),
    },
    // Capture templates passed to Menu.buildFromTemplate so tests can drive clicks.
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => {
        builtTemplates.push(template);
        return { popup: vi.fn() };
      }),
      setApplicationMenu: vi.fn(),
    },
  })
);
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('../../../src/lib/shared/logger', (orig) => silenceLogger(orig));

import { createApplicationMenu } from '../menu';
import { createSystemTray, destroyTray, getTray } from '../system-tray';

interface TemplateItem {
  label?: string;
  role?: string;
  click?: () => void;
  submenu?: TemplateItem[];
}

function walk(items: TemplateItem[], visit: (i: TemplateItem) => void): void {
  for (const item of items) {
    visit(item);
    if (Array.isArray(item.submenu)) walk(item.submenu, visit);
  }
}

function findByLabel(items: TemplateItem[], label: string): TemplateItem | undefined {
  let found: TemplateItem | undefined;
  walk(items, (i) => {
    if (i.label === label) found = i;
  });
  return found;
}

describe('createApplicationMenu', () => {
  beforeEach(() => {
    builtTemplates.length = 0;
  });

  it('builds a menu and returns it', () => {
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    const menu = createApplicationMenu(win as never);
    expect(menu).toBeTruthy();
    expect(builtTemplates).toHaveLength(1);
    expect(builtTemplates[0]!.length).toBeGreaterThan(0);
  });

  it('"Check for Updates…" sends app:check-updates to a live window', () => {
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } };
    createApplicationMenu(win as never);
    const item = findByLabel(builtTemplates[0] as TemplateItem[], 'Check for Updates…');
    expect(item).toBeDefined();
    item!.click!();
    expect(send).toHaveBeenCalledWith('app:check-updates');
  });

  it('menu clicks no-op on a destroyed window', () => {
    const send = vi.fn();
    const win = { isDestroyed: () => true, webContents: { send } };
    createApplicationMenu(win as never);
    const item = findByLabel(builtTemplates[0] as TemplateItem[], 'Check for Updates…');
    item!.click!();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('system tray', () => {
  it('creates a tray when an icon is available, then tears it down', () => {
    expect(getTray()).toBeNull();
    const tray = createSystemTray(() => null, true);
    expect(tray).not.toBeNull();
    expect(getTray()).toBe(tray);

    destroyTray();
    expect(getTray()).toBeNull();
  });
});
