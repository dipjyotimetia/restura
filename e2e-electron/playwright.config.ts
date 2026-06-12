import { defineConfig } from '@playwright/test';

/**
 * Desktop (Electron) e2e suite. Launches the compiled, unpacked app via
 * Playwright's `_electron` API — no electron-builder packaging and no Vite
 * dev server / Worker involved. Build prerequisites:
 *
 *   npm run test:e2e:electron:build   # electron:build:web + electron:compile
 *   npm run test:e2e:electron
 *
 * Kept separate from playwright.config.ts because that config's webServer
 * (Vite + Miniflare) and `.dev.vars` bootstrap are web-only concerns.
 */
export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One worker: each worker launches its own Electron instance; serial keeps
  // resource usage sane and avoids cross-instance keychain contention.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
});
