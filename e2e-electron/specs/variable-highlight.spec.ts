import { test, expect } from '../fixtures/servers';
import { switchMode, setUrl, fillFirstMonacoEditor } from '../../e2e/utils/selectors';

/**
 * End-to-end coverage for `{{var}}` highlighting across every HTTP request
 * input on the desktop renderer: the URL bar overlay, the params/headers value
 * overlay, and the Monaco body decorations. Proves the resolved (amber) vs
 * unresolved (red) distinction the Environment Manager promises — a defined
 * variable resolves, an undefined one is flagged before the request fires.
 *
 * One env is created and made active up front; the three surfaces are then
 * exercised in the same window (worker-scoped Electron instance).
 */
test.describe('Desktop variable highlighting', () => {
  test('resolved vs unresolved tokens in URL, params and the Monaco body', async ({
    app: page,
    servers,
  }) => {
    // --- active env with a single `baseUrl` variable -----------------------
    await page.getByRole('button', { name: /Switch environment/ }).click();
    const envDialog = page.getByRole('dialog', { name: 'Environments' });
    await envDialog.getByRole('button').filter({ hasText: 'Local' }).first().click();
    await envDialog.getByRole('button', { name: 'Add variable' }).click();
    await envDialog.getByPlaceholder('Variable name').last().fill('baseUrl');
    await envDialog.getByPlaceholder('Variable value').last().fill(servers.http.url);
    await envDialog.getByRole('button', { name: 'Set as active' }).click();
    await envDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(envDialog).not.toBeVisible();

    await switchMode(page, 'http');

    // --- 1. URL bar overlay ------------------------------------------------
    await setUrl(page, '{{baseUrl}}/{{missing}}/json');
    await page.keyboard.press('Escape');
    await expect(page.locator('.sp-variable')).toHaveText('{{baseUrl}}');
    await expect(page.locator('.sp-variable-unresolved')).toHaveText('{{missing}}');
    await expect(page.locator('.sp-variable-unresolved')).toHaveAttribute(
      'title',
      /Unresolved variable: missing/
    );

    // --- 2. Params value overlay ------------------------------------------
    // Scope to the rows container — the URL bar overlay above also paints a
    // `.sp-variable` for {{baseUrl}}, so the page-wide locator isn't unique.
    const rows = page.getByRole('rowgroup');
    await page.getByPlaceholder('Key', { exact: true }).last().fill('q');
    const ghostValue = page.getByPlaceholder('Value', { exact: true }).last();
    await ghostValue.fill('{{baseUrl}}-{{missing}}');
    await ghostValue.press('Enter');
    // The committed row input goes transparent; only the overlay paints tokens.
    await expect(page.getByPlaceholder('value', { exact: true }).first()).toHaveClass(
      /text-transparent/
    );
    await expect(rows.locator('.sp-variable')).toHaveText('{{baseUrl}}');
    await expect(rows.locator('.sp-variable-unresolved')).toHaveText('{{missing}}');

    // --- 3. Monaco body decorations ---------------------------------------
    await page.getByRole('tab', { name: 'Body', exact: true }).click();
    await page
      .getByRole('radio', { name: 'JSON', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await fillFirstMonacoEditor(page, '{ "u": "{{baseUrl}}", "m": "{{missing}}" }');

    // Resolved → accent decoration; unresolved → warning decoration. Monaco
    // splits the string token at the decoration boundary, so each decorated
    // span holds exactly the {{token}}.
    await expect(page.locator('.monaco-var-resolved').first()).toHaveText('{{baseUrl}}');
    await expect(page.locator('.monaco-var-unresolved').first()).toHaveText('{{missing}}');
  });
});
