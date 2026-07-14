import { validateURL } from '@shared/protocol/url-validation';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import * as path from 'path';
import { createLogger } from '../../../src/lib/shared/logger';

const log = createLogger('deep-link');

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

// Known routes the renderer handles via deep-link
const VALID_DEEP_LINK_HOSTS = new Set([
  'import',
  'environment',
  'collection',
  'request',
  'settings',
]);

// Param keys whose values are URLs and must pass validateURL before forwarding.
const URL_PARAM_KEYS = new Set(['url', 'href', 'src', 'callback']);

function handleDeepLink(url: string, getWindow: () => BrowserWindow | null): void {
  const win = getWindow();
  if (!win) return;

  try {
    const parsed = new URL(url);
    if (!VALID_DEEP_LINK_HOSTS.has(parsed.hostname)) return;

    // Sanitize: only alphanumeric keys, values capped at 1024 chars
    const params: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams) {
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) continue;
      const truncated = value.slice(0, 1024);
      if (URL_PARAM_KEYS.has(key.toLowerCase())) {
        const v = validateURL(truncated, { allowPrivateIPs: false, allowLocalhost: false });
        if (!v.valid) {
          log.warn('dropped unsafe deep-link param', { key, value: truncated, reason: v.error });
          continue;
        }
      }
      params[key] = truncated;
    }

    win.webContents.send('deep-link', { host: parsed.hostname, params });
  } catch {
    // Ignore malformed deep link URLs
  }
}

// Test seam — exported only for unit tests.
export const __test_handleDeepLink = handleDeepLink;
