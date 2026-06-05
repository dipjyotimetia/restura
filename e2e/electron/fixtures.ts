// Playwright fixtures for the Electron launch harness.
//
// Unlike the chromium e2e suite (which boots the Vite dev server and drives the
// web build), this launches the ACTUALLY-BUILT desktop app — the compiled main
// process + the file:// renderer + the real preload bridge — and exercises live
// IPC. Run `npm run electron:build:all` first; see playwright.electron.config.ts.
import { test as base, _electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'node:path';

// Playwright runs from the repo root. electron:compile emits with rootDir=..,
// so electron/main/main.ts lands at this nested path.
export const MAIN_ENTRY = path.resolve(process.cwd(), 'dist/electron/electron/main/main.js');

interface ElectronFixtures {
  electronApp: ElectronApplication;
  window: Page;
}

export const test = base.extend<ElectronFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a fixtures destructure here
  electronApp: async ({}, use) => {
    const app = await _electron.launch({
      args: [MAIN_ENTRY],
      // No NODE_ENV=development → window-manager loads dist/web/index.html via
      // file:// (prod path) instead of the dev server. RESTURA_E2E marks the run.
      env: { ...process.env, NODE_ENV: 'test', RESTURA_E2E: '1' },
    });
    await use(app);
    await app.close();
  },
  window: async ({ electronApp }, use) => {
    const win = await electronApp.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

export { expect } from '@playwright/test';

/**
 * Minimal structural type for the parts of `window.electron` the harness drives.
 * Types are erased at runtime, so specs can reference this inside `evaluate`
 * closures to avoid `any` while still calling the real preload bridge.
 */
export interface HarnessIpc {
  isElectron: boolean;
  platform: string;
  store: {
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | undefined>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<void>;
  };
  keychain: {
    status(): Promise<{ mode: string; plaintextStores: unknown[] }>;
  };
  http: {
    request(config: { method: string; url: string }): Promise<{ status?: number }>;
  };
}
