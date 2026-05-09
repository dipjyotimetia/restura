import { defineConfig, devices } from '@playwright/test';
import { bootstrapPrereqs } from './e2e/global-setup';

// Runs synchronously at config-load time, BEFORE Playwright spawns
// webServer. That ordering is load-bearing — `.dev.vars` must exist before
// miniflare reads it on `npm run dev` startup, otherwise the Worker boots
// in production mode and the proxy/grpc/mcp tests get 503s.
bootstrapPrereqs();

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    // Mock HTTPS server uses a self-signed cert; trust it in tests.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    // CI always starts cold so .dev.vars is guaranteed to be loaded by miniflare.
    // Locally we reuse a hot dev server for fast iteration.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
