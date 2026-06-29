import { defineConfig } from '@playwright/test';

/**
 * Standalone Playwright config for the browser capture extension e2e. Unlike the
 * main config it boots NO dev server — the extension spec manages its own
 * Chromium persistent context with the unpacked extension loaded.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /extension-capture\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // Keep traces/screenshots on failure so the CI artifact upload is useful.
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
