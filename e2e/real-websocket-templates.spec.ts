import { expect, test } from './fixtures/servers';
import { switchMode } from './utils/selectors';

/**
 * Saved messages, `{{var}}` resolution in sent frames and per-frame assertion
 * scripts against the real /echo WebSocket mock (#927, #931, #974).
 */
test.describe('WebSocket saved messages + frame assertions', () => {
  test('saves, loads and sends a template with variables resolved at send time', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'ws');
    await page.getByRole('textbox', { name: 'WebSocket URL' }).fill(`${servers.ws.url}/echo`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('radio', { name: 'text' }).click();

    const composer = page.getByPlaceholder(/Enter message to send/i);
    await expect(composer).toBeEnabled({ timeout: 10_000 });
    await composer.fill('hi {{$randomInt}} {{missingVar}}');

    await page.getByRole('button', { name: /^Saved/ }).click();
    await page.getByRole('button', { name: /Save current/ }).click();
    const rename = page.getByRole('textbox', { name: 'Rename saved message' });
    await rename.fill('Greeting');
    await rename.press('Enter');

    await composer.fill('');
    await page.getByTitle(/Load into composer/).click();
    await expect(composer).toHaveValue('hi {{$randomInt}} {{missingVar}}');

    await page.getByRole('button', { name: 'Send Greeting' }).click();
    await expect
      .poll(() => servers.ws.receivedMessages().map((m) => m.payload), { timeout: 10_000 })
      .toContainEqual(expect.stringMatching(/^hi \d+ \{\{missingVar\}\}$/));
    await expect(
      page.getByText('Unresolved variables sent literally: {{missingVar}}').first()
    ).toBeVisible();
    // The saved template itself stays unresolved.
    await expect(page.getByText('text · hi {{$randomInt}} {{missingVar}}')).toBeVisible();

    await page
      .getByRole('button', { name: /Disconnect/i })
      .first()
      .click()
      .catch(() => {});
  });

  test('runs the frame assertion script on received frames', async ({ app: page, servers }) => {
    await switchMode(page, 'ws');
    await page.getByRole('textbox', { name: 'WebSocket URL' }).fill(`${servers.ws.url}/echo`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('radio', { name: 'text' }).click();
    const composer = page.getByPlaceholder(/Enter message to send/i);
    await expect(composer).toBeEnabled({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Frame assertions' }).click();
    const script = page.getByRole('textbox', { name: 'Frame assertion script' });
    await script.fill(
      "pm.test('echo prefix', () => pm.expect(pm.response.text()).to.match(/^echo:/));"
    );
    await page.getByRole('switch', { name: 'Enable frame assertions' }).click();
    await page.keyboard.press('Escape');

    await composer.fill('assert-me');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('frame-assertion-badge').first()).toHaveText('✓ 1/1', {
      timeout: 15_000,
    });

    await page
      .getByRole('button', { name: /Disconnect/i })
      .first()
      .click()
      .catch(() => {});
  });
});
