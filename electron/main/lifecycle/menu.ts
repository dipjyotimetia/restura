import type { BaseWindow, BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { app, dialog, BrowserWindow as ElectronBrowserWindow, Menu, shell } from 'electron';

/**
 * The application menu is process-global but windows are not: resolve the
 * window a menu click targets at click time (the window Electron says the
 * item was activated from, else the focused window, else the creation-time
 * window) and never hand back a destroyed one.
 */
function resolveTarget(
  fallback: BrowserWindow,
  clicked: BaseWindow | undefined
): BrowserWindow | null {
  const focused = ElectronBrowserWindow.getFocusedWindow();
  for (const w of [clicked, focused, fallback]) {
    if (w && !w.isDestroyed() && 'webContents' in w) return w as BrowserWindow;
  }
  return null;
}

export function createApplicationMenu(mainWindow: BrowserWindow): Menu {
  const isMac = process.platform === 'darwin';
  const sendTo = (channel: string) => (_item: unknown, win: BaseWindow | undefined) => {
    resolveTarget(mainWindow, win)?.webContents.send(channel);
  };

  // Reuses the same `app:check-updates` event the system tray emits; the
  // renderer (UpdateNotification.tsx) gives it transient toast feedback.
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: sendTo('app:check-updates'),
  };

  // Opens the renderer's Settings drawer. Accelerator matches the renderer's own
  // `mod+,` keybinding (opening is idempotent, so the two paths can't conflict).
  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? 'Settings…' : 'Preferences',
    accelerator: 'CmdOrCtrl+,',
    click: sendTo('menu:settings'),
  };

  const template: MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              checkForUpdatesItem,
              { type: 'separator' as const },
              settingsItem,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),

    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Request',
          accelerator: 'CmdOrCtrl+N',
          click: sendTo('menu:new-request'),
        },
        // Tab shortcuts live in the menu so they win over the window-level
        // defaults: Cmd/Ctrl+W closes the active request tab (the window close
        // moves to Cmd/Ctrl+Shift+W, matching browsers and editors).
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: sendTo('menu:close-tab'),
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: sendTo('menu:reopen-tab'),
        },
        { type: 'separator' },
        {
          label: 'Import Collection...',
          accelerator: 'CmdOrCtrl+I',
          click: sendTo('menu:import'),
        },
        {
          label: 'Export Collection...',
          accelerator: 'CmdOrCtrl+E',
          click: sendTo('menu:export'),
        },
        { type: 'separator' },
        // macOS surfaces Settings in the app menu; elsewhere File is its home.
        ...(!isMac ? [settingsItem, { type: 'separator' as const }] : []),
        isMac
          ? { role: 'close' as const, accelerator: 'CmdOrCtrl+Shift+W' }
          : { role: 'quit' as const },
      ],
    },

    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const },
              { role: 'delete' as const },
              { role: 'selectAll' as const },
            ]
          : [
              { role: 'delete' as const },
              { type: 'separator' as const },
              { role: 'selectAll' as const },
            ]),
      ],
    },

    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },

    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const },
            ]
          : [{ role: 'close' as const, accelerator: 'CmdOrCtrl+Shift+W' }]),
      ],
    },

    // Help menu
    {
      role: 'help' as const,
      submenu: [
        // macOS surfaces this in the app menu (platform convention); elsewhere
        // Help is the discoverable home for it.
        ...(!isMac ? [checkForUpdatesItem, { type: 'separator' as const }] : []),
        {
          label: 'Documentation',
          click: async () => {
            await shell.openExternal('https://github.com/dipjyotimetia/restura');
          },
        },
        {
          label: 'Report a Bug…',
          click: sendTo('menu:report-bug'),
        },
        {
          label: 'Open Logs',
          click: () => {
            void shell.openPath(app.getPath('logs'));
          },
        },
        { type: 'separator' },
        {
          label: 'About Restura',
          click: (_item: unknown, win: BaseWindow | undefined) => {
            const version = app.getVersion();
            const electronVersion = process.versions.electron;
            const chromeVersion = process.versions.chrome;
            const nodeVersion = process.versions.node;

            const target = resolveTarget(mainWindow, win);
            if (!target) return;
            dialog.showMessageBox(target, {
              type: 'info',
              title: 'About Restura',
              message: 'Restura',
              detail: `Version: ${version}\nElectron: ${electronVersion}\nChrome: ${chromeVersion}\nNode.js: ${nodeVersion}`,
            });
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
