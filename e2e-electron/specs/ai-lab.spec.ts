import { expect, test } from '../fixtures/servers';

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
      // Models workspace → connect an openai-compatible provider pointed at the mock.
      // Connect & save validates and discovers in one secure, handle-only flow.
      await page.getByRole('button', { name: 'Models', exact: true }).click();
      await page.getByRole('combobox').first().click();
      await page.getByRole('option', { name: /OpenAI-compatible/i }).click();
      await page.getByPlaceholder('e.g. Local Ollama').fill('Mock LLM');
      await page.getByPlaceholder('http://localhost:11434').fill(servers.http.url);
      // API key intentionally blank — local provider, no secret/keychain.
      await page.getByRole('button', { name: 'Connect & save' }).click();
      await expect(page.getByText('mock-model').first()).toBeVisible({
        timeout: 15_000,
      });

      // Favorite the discovered model so the catalog curation path is covered.
      await page.getByRole('button', { name: 'Add mock-model to favorites' }).click();

      // Playground → select the discovered model → run a completion. The model
      // checklist groups by provider: "Mock LLM" renders as a group header and
      // "mock-model" as the selectable row, so target the row's <label>
      // (clicking it toggles the wrapped checkbox).
      await page.getByRole('button', { name: 'Playground', exact: true }).click();
      await page.locator('label', { hasText: 'mock-model' }).click({ timeout: 15_000 });
      await page.getByRole('button', { name: /run on/i }).click();

      // The mock streams choices[].delta.content = "echo: hello".
      await expect(page.getByText('echo: hello').first()).toBeVisible({
        timeout: 20_000,
      });
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

  // Reuses the provider connected above: the window and its stores are shared
  // across this file. Covers the controls added by the 2026-10-12 review fixes
  // (epic #1057) in their real workspaces, that a loopback provider is not refused
  // by the cloud secret check (#1028), and that none of it raises a renderer error.
  test('review-batch controls work, and a local run accepts a secret in the prompt', async ({
    app: page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.evaluate(() => {
      window.location.hash = '#/ai-lab';
    });
    try {
      await page.getByRole('button', { name: 'Playground', exact: true }).click();
      const playgroundOverride = page.getByTestId('playground-send-unredacted');
      await expect(playgroundOverride).not.toBeChecked();
      await playgroundOverride.click();
      await expect(playgroundOverride).toBeChecked();
      await playgroundOverride.click();
      await expect(playgroundOverride).not.toBeChecked();
      await page.locator('textarea').first().fill('key is AKIAIOSFODNN7EXAMPLE');
      await page.getByRole('button', { name: /run on/i }).click();
      await expect(page.getByText('echo: hello').first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(/Refused to send/)).toHaveCount(0);

      await page.getByRole('button', { name: 'Arena', exact: true }).click();
      const arenaOverride = page.getByTestId('arena-send-unredacted');
      await expect(arenaOverride).not.toBeChecked();
      await arenaOverride.click();
      await expect(arenaOverride).toBeChecked();

      // The threshold can be cleared while typing and clamps on blur (#1024).
      await page.getByRole('button', { name: 'Evals', exact: true }).click();
      const threshold = page.getByTestId('eval-pass-threshold');
      await expect(threshold).toHaveValue('100');
      await threshold.fill('');
      await expect(threshold).toHaveValue('');
      await threshold.fill('0');
      await threshold.blur();
      await expect(threshold).toHaveValue('1');
      await threshold.fill('75');
      await threshold.blur();
      await expect(threshold).toHaveValue('75');
      await expect(page.getByTestId('eval-tools-editor')).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await page.evaluate(() => {
        window.location.hash = '#/';
      });
      await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible({
        timeout: 15_000,
      });
    }
  });
});
