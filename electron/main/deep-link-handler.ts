import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import * as path from 'path';

export function registerDeepLinkHandler(getWindow: () => BrowserWindow | null): void {
  // In development mode with process.defaultApp, set protocol client with explicit execPath
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('restura', process.execPath, [path.resolve(process.argv[1]!)]);
  } else {
    app.setAsDefaultProtocolClient('restura');
  }

  // macOS: open-url event fires when app is already running
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url, getWindow);
  });

  // Windows/Linux: second-instance fires when another instance is launched
  // (requires single-instance lock to be requested before calling this)
  app.on('second-instance', (_event, argv) => {
    const deepLinkUrl = argv.find((arg) => arg.startsWith('restura://'));
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl, getWindow);
    }
    const win = getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function handleDeepLink(url: string, getWindow: () => BrowserWindow | null): void {
  const win = getWindow();
  if (!win) return;

  try {
    const parsed = new URL(url);
    win.webContents.send('deep-link', {
      host: parsed.hostname,
      params: Object.fromEntries(parsed.searchParams),
    });
  } catch {
    // Ignore malformed deep link URLs
  }
}
