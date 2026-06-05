import { defineConfig } from '@playwright/test';

// Dedicated config for the Electron launch harness. Deliberately has NO
// `webServer` and NO `baseURL`: the built desktop app loads dist/web/index.html
// over file:// and talks to upstreams through the Electron main process, not the
// Vite dev server. Run `npm run electron:build:all` before this (the
// test:electron:e2e script chains it). The chromium e2e config ignores
// e2e/electron/** so the two suites never cross-load.
export default defineConfig({
  testDir: './e2e/electron',
  testMatch: '**/*.electron.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
});
