import { test, expect } from '../fixtures/servers';

/**
 * Desktop AI Lab against a LOCAL mock LLM — renderer → IPC → ai-lab-handler →
 * the in-process OpenAI-compatible mock (`/v1/models` + streaming
 * `/v1/chat/completions`). The AI assistant chat is cloud-only (its UI has no
 * base-URL field and the SSRF guard blocks cloud providers from localhost), so
 * AI Lab's `openai-compatible` provider — which the localhost carve-out permits —
 * is the e2e-able surface. Proves provider config → model discovery → a real
 * streamed completion end-to-end (fail-when-broken: a dropped stream renders no
 * "echo: hello").
 */
test.describe('Desktop AI Lab (local OpenAI-compatible provider)', () => {
  test('configures a local provider, discovers its model, and runs a completion', async ({
    app: page,
    servers,
  }) => {
    await page.evaluate(() => {
      window.location.hash = '#/ai-lab';
    });
    try {
      // Providers tab → add an openai-compatible provider pointed at the mock.
      await page.getByRole('tab', { name: 'Providers' }).click();
      await page.getByRole('combobox').first().click();
      await page.getByRole('option', { name: /OpenAI-compatible/i }).click();
      await page.getByPlaceholder('e.g. Local Ollama').fill('Mock LLM');
      await page.getByPlaceholder('http://localhost:11434').fill(servers.http.url);
      // API key intentionally blank — local provider, no secret/keychain.
      await page.getByRole('button', { name: 'Add provider' }).click();

      // Discover the mock's model (GET /v1/models from the main process).
      await page.getByRole('button', { name: 'Discover models' }).click();

      // Playground → select the discovered model → run a completion.
      await page.getByRole('tab', { name: 'Playground' }).click();
      await page.getByText('Mock LLM · mock-model').click({ timeout: 15_000 });
      await page.getByRole('button', { name: /run on/i }).click();

      // The mock streams choices[].delta.content = "echo: hello".
      await expect(page.getByText('echo: hello').first()).toBeVisible({ timeout: 20_000 });
    } finally {
      // Restore the request workspace — the window is shared across specs.
      await page.evaluate(() => {
        window.location.hash = '#/';
      });
      await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible({
        timeout: 15_000,
      });
    }
  });
});
