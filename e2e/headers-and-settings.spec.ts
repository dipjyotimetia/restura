import { test, expect } from './fixtures/app';
import { mockProxy } from './utils/mockProxy';
import { headersTab, setUrl, settingsTab } from './utils/selectors';

test.describe('Headers autocomplete', () => {
  test('opens suggestions, filters by substring, and selecting Content-Type auto-fills application/json', async ({
    app: page,
  }) => {
    await mockProxy(page, () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    }));

    await setUrl(page, 'https://api.example.com/with-headers');
    await headersTab(page).click();

    // Headers tab starts empty — add a row, then focus the KEY combobox.
    await page.getByRole('button', { name: /Add header/i }).click();
    const keyInput = page.getByRole('combobox', { name: 'key' }).first();
    await keyInput.click();
    await keyInput.fill('con');

    // Filter should leave Content-Type visible; pick it.
    const contentTypeOption = page.getByRole('option', { name: /Content-Type/i }).first();
    await expect(contentTypeOption).toBeVisible();
    await contentTypeOption.click();

    // Value cell should auto-fill application/json (the catalog's first default)
    await expect(page.getByRole('combobox', { name: 'value' }).first()).toHaveValue(
      'application/json'
    );
  });

  test('Authorization suggests "Bearer " as the default', async ({ app: page }) => {
    await setUrl(page, 'https://api.example.com/with-auth');
    await headersTab(page).click();
    await page.getByRole('button', { name: /Add header/i }).click();

    const keyInput = page.getByRole('combobox', { name: 'key' }).first();
    await keyInput.click();
    await keyInput.fill('auth');
    await page
      .getByRole('option', { name: /Authorization/i })
      .first()
      .click();

    await expect(page.getByRole('combobox', { name: 'value' }).first()).toHaveValue('Bearer ');
  });

  test('Params tab keeps plain inputs (no combobox role)', async ({ app: page }) => {
    await setUrl(page, 'https://api.example.com/no-combobox-on-params');
    // Add a Params row, then confirm its key field is a plain <input>, not a
    // combobox — Params explicitly do NOT receive the header-name catalog.
    await page.getByRole('button', { name: /Add parameter/i }).click();
    const comboboxes = page.getByRole('combobox', { name: 'key' });
    await expect(comboboxes).toHaveCount(0);
  });

  test('typing a non-standard header name is accepted as free-form', async ({ app: page }) => {
    await setUrl(page, 'https://api.example.com/custom-header');
    await headersTab(page).click();
    await page.getByRole('button', { name: /Add header/i }).click();

    const keyInput = page.getByRole('combobox', { name: 'key' }).first();
    await keyInput.click();
    await keyInput.fill('X-Custom-Header');
    // Press Tab to close the dropdown without selecting.
    await keyInput.press('Tab');

    // The custom value sticks; no default value was auto-filled (there are no
    // suggestions for X-Custom-Header, so the VALUE column stays a plain input).
    await expect(keyInput).toHaveValue('X-Custom-Header');
  });
});

test.describe('Request settings — UI state', () => {
  test('new redirect toggles render under "Follow redirects" when override is on', async ({
    app: page,
  }) => {
    await settingsTab(page).click();
    await page.getByRole('switch', { name: 'Toggle settings override' }).click();

    // Nested follow-redirect knobs should appear.
    await expect(
      page.getByRole('switch', { name: 'Toggle follow original method on redirect' })
    ).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Toggle follow Authorization across hostnames' })
    ).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Toggle strip Referer on redirect' })
    ).toBeVisible();
  });

  test('Encode URL automatically defaults ON and is togglable', async ({ app: page }) => {
    await settingsTab(page).click();
    await page.getByRole('switch', { name: 'Toggle settings override' }).click();
    const encodeSwitch = page.getByRole('switch', { name: 'Toggle automatic URL encoding' });
    // Default state is ON
    await expect(encodeSwitch).toHaveAttribute('aria-checked', 'true');
    await encodeSwitch.click();
    await expect(encodeSwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('Disable cookie jar toggle appears in Network section', async ({ app: page }) => {
    await settingsTab(page).click();
    await page.getByRole('switch', { name: 'Toggle settings override' }).click();
    await expect(page.getByRole('switch', { name: 'Toggle disable cookie jar' })).toBeVisible();
  });

  test('TLS advanced disclosure reveals min-version + cipher-suites', async ({ app: page }) => {
    await settingsTab(page).click();
    await page.getByRole('switch', { name: 'Toggle settings override' }).click();

    // Min TLS version + cipher suites are hidden by default; click "TLS advanced".
    await page.getByRole('button', { name: /TLS advanced/i }).click();

    await expect(page.getByLabel(/Minimum TLS version/i)).toBeVisible();
    await expect(page.getByPlaceholder(/ECDHE-RSA-AES128-GCM-SHA256/i)).toBeVisible();
  });

  test('toggles persist across re-opening the Settings tab', async ({ app: page }) => {
    await settingsTab(page).click();
    await page.getByRole('switch', { name: 'Toggle settings override' }).click();
    await page.getByRole('switch', { name: 'Toggle disable cookie jar' }).click();

    // Switch to Headers, then back to Settings — toggle state should survive.
    await headersTab(page).click();
    await settingsTab(page).click();

    await expect(page.getByRole('switch', { name: 'Toggle disable cookie jar' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
