import { test, expect } from '@playwright/test';

/**
 * The AI chat is desktop-only — every entry point is gated behind
 * `isElectron()` (the TopBar toggle, the ChatPanel mount, and the live
 * ProviderSettings render). This Playwright harness runs the WEB build against
 * the Vite dev server (no Electron, no `window.electron`), so the meaningful
 * end-to-end guarantee we can assert here is that the feature is correctly
 * gated OFF in web — i.e. no AI entry point leaks into the Cloudflare Pages
 * deployment.
 *
 * The full streaming round-trip against the local `echo/` server is
 * Electron-only: it needs Playwright's `_electron` launcher (to get
 * `window.electron.ai` + the OS-keychain secret store), which this config does
 * not yet provide. That path is covered at the unit/integration layer
 * (shared/protocol/ai/* decoders + ai-proxy, electron/main/ai-handler) and is
 * left here as a documented, skipped follow-up.
 */

test.describe('AI chat — web build gating', () => {
  test('does not expose the AI toggle in the web build', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /toggle ai chat/i })).toHaveCount(0);
  });

  test('does not mount the AI chat panel in the web build', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('complementary', { name: /ai panel|ai chat/i })).toHaveCount(0);
  });
});

// Electron-only: requires launching the packaged app via Playwright's
// `_electron` API and pointing a provider `baseUrlOverride` at the local echo
// server (POST /v1/chat/completions, /v1/messages). Not runnable against the
// web dev server; tracked as a follow-up once an Electron e2e harness exists.
test.describe.skip('AI chat round-trip (Electron-only — needs _electron harness)', () => {
  test('streams an echo response end to end', async () => {
    // 1. _electron.launch() the packaged app.
    // 2. Settings → AI: store a fake key, set baseUrlOverride to the echo server.
    // 3. Open the AI panel, send "hello", expect a streamed "echo: hello".
  });

  test('Stop button cancels an in-flight stream', async () => {
    // Send a message, click Stop mid-stream, assert the stream ends as cancelled.
  });
});
