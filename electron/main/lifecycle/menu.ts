import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { app, dialog, Menu, shell } from 'electron';

export function createApplicationMenu(mainWindow: BrowserWindow): Menu {
  const isMac = process.platform === 'darwin';

  // Brand the native "About Restura" panel (macOS `role: 'about'`) instead of
  // showing a bare default. macOS sources the icon from the app bundle.
  app.setAboutPanelOptions({
    applicationName: 'Restura',
    applicationVersion: app.getVersion(),
    copyright: `© ${new Date().getFullYear()} Restura · The API client that speaks every protocol.`,
    credits: 'One client. Every protocol. — Web · Desktop · Self-hosted.',
  });

  // Reuses the same `app:check-updates` event the system tray emits; the
  // renderer (UpdateNotification.tsx) gives it transient toast feedback.
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => {
      if (mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('app:check-updates');
    },
  };

  // Opens the renderer's Settings drawer. Accelerator matches the renderer's own
  // `mod+,` keybinding (opening is idempotent, so the two paths can't conflict).
  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? 'Settings…' : 'Preferences',
    accelerator: 'CmdOrCtrl+,',
    click: () => {
      if (mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('menu:settings');
    },
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
          click: () => {
            mainWindow.webContents.send('menu:new-request');
          },
        },
        { type: 'separator' },
        {
          label: 'Import Collection...',
          accelerator: 'CmdOrCtrl+I',
          click: () => {
            mainWindow.webContents.send('menu:import');
          },
        },
        {
          label: 'Export Collection...',
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            mainWindow.webContents.send('menu:export');
          },
        },
        { type: 'separator' },
        // macOS surfaces Settings in the app menu; elsewhere File is its home.
        ...(!isMac ? [settingsItem, { type: 'separator' as const }] : []),
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
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
          : [{ role: 'close' as const }]),
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
          label: 'Report Issue',
          click: async () => {
            const os =
              process.platform === 'darwin'
                ? 'macOS'
                : process.platform === 'win32'
                  ? 'Windows'
                  : 'Linux';
            const body = [
              '## Bug Description',
              '',
              '<!-- A clear and concise description of what the bug is -->',
              '',
              '## Steps to Reproduce',
              '',
              "1. Go to '...'",
              "2. Click on '...'",
              '4. See error',
              '',
              '## Expected Behavior',
              '',
              '<!-- What you expected to happen -->',
              '',
              '## Actual Behavior',
              '',
              '<!-- What actually happened -->',
              '',
              '## Environment',
              '',
              `- OS: ${os}`,
              '- Node Version: [e.g. 20.10.0]',
              `- Restura Version: v${app.getVersion()}`,
              '',
              '**Application Type:**',
              '',
              '- [x] Electron Desktop App',
              '- [ ] Web Client',
              '',
              '## Console Errors',
              '',
              '```',
              'Paste error logs here',
              '```',
            ].join('\n');
            await shell.openExternal(
              'https://github.com/dipjyotimetia/restura/issues/new?' +
                new URLSearchParams({ labels: 'bug', title: '[BUG] ', body }).toString()
            );
          },
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
          click: () => {
            const version = app.getVersion();
            const electronVersion = process.versions.electron;
            const chromeVersion = process.versions.chrome;
            const nodeVersion = process.versions.node;

            if (mainWindow.isDestroyed()) return;
            dialog.showMessageBox(mainWindow, {
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
