import { test, expect } from '../fixtures/servers';

/**
 * Desktop AI assistant CHAT against a LOCAL mock LLM. Previously the chat was
 * cloud-only (no base-URL field; SSRF blocked localhost), so it was untestable
 * and unusable with local runtimes. Now an `openai-compatible` provider can be
 * configured in chat settings (base URL + model, no API key), reusing AI Lab's
 * safe localhost-only SSRF carve-out. This drives configure → open chat → send →
 * stream end-to-end against the mock (`/v1/chat/completions` SSE = "echo: hello").
 */
test.describe('Desktop AI chat (local OpenAI-compatible provider)', () => {
  test('streams a reply from a local provider configured in chat settings', async ({
    app: page,
    servers,
  }) => {
    // Configure the local provider in Settings → AI.
    await page.getByRole('button', { name: 'Open settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Settings' });
    await drawer.getByRole('button', { name: 'AI', exact: true }).click();
    await drawer.getByRole('combobox').first().click();
    await page.getByRole('option', { name: /OpenAI-compatible/i }).click();
    await drawer.getByPlaceholder('http://localhost:11434').fill(servers.http.url);
    await drawer.getByPlaceholder(/local model id/).fill('mock-model');
    await drawer.getByRole('button', { name: 'Save local provider' }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();

    try {
      await page.getByRole('button', { name: 'Toggle AI chat' }).click();
      const composer = page.getByPlaceholder(/Ask about/i);
      await expect(composer).toBeEnabled({ timeout: 10_000 });
      await composer.fill('hello');
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      // The mock streams choices[].delta.content = "echo: hello".
      await expect(page.getByText('echo: hello').first()).toBeVisible({ timeout: 20_000 });
    } finally {
      // Close the panel so it doesn't bleed into later specs in the shared window.
      await page
        .getByRole('button', { name: 'Toggle AI chat' })
        .click()
        .catch(() => {});
    }
  });
});
