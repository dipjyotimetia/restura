import { test, expect } from '../fixtures/tls';
import { switchMode, setUrl, sendButton } from '../../e2e/utils/selectors';
import { TEST_AUTH_FIXTURES } from '../../e2e/mocks/authRoutes';

/**
 * Desktop OAuth 2.0 (client-credentials), end-to-end. Unlike the sign-at-wire
 * auths, the token is fetched by a RENDERER `fetch()` (the packaged CSP allows
 * https: only), so the token endpoint runs on the https mock — reachable because
 * the e2e launch sets the test-only `--ignore-certificate-errors` switch (renderer
 * TLS only; see fixtures/electronApp.ts). The acquired JWT is then applied as a
 * bearer on the normal IPC send to /oauth/protected (verifySsl off so undici
 * accepts the private-CA leaf). A 200 proves fetch-token → apply → verify.
 *
 * Also a regression guard for the schema bug fixed alongside this: oauth2's
 * `accessToken` was REQUIRED, so configuring the provider before fetching a token
 * was rejected by validateRequestUpdate — OAuth2 was unconfigurable in the UI.
 */
const CLIENT = TEST_AUTH_FIXTURES.client;

test.describe('Desktop OAuth 2.0 (client credentials)', () => {
  test('fetches a token over https and authenticates the request', async ({ app: page, tls }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${tls.https.url}/oauth/protected`);

    // verifySsl off — the IPC/undici send must accept the mock's private-CA leaf.
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    const override = page
      .getByRole('switch', { name: 'Toggle settings override' })
      .filter({ visible: true })
      .first();
    if ((await override.getAttribute('aria-checked')) !== 'true') await override.click();
    const verify = page
      .getByRole('switch', { name: 'Toggle SSL verification' })
      .filter({ visible: true })
      .first();
    if ((await verify.getAttribute('aria-checked')) === 'true') await verify.click();

    // Configure OAuth2 client-credentials against the https token endpoint.
    await page.getByRole('tab', { name: 'Auth', exact: true }).click();
    await page.getByRole('button', { name: 'OAuth 2.0', exact: true }).click();
    await page.getByRole('combobox').filter({ visible: true }).first().click();
    await page.getByRole('option', { name: 'Client Credentials' }).click();
    await page.getByPlaceholder('Enter client ID').fill(CLIENT.id);
    await page.getByPlaceholder('Enter client secret (optional for PKCE)').fill(CLIENT.secret);
    await page
      .getByPlaceholder('https://auth.example.com/token')
      .fill(`${tls.https.url}/oauth/token`);

    await page.getByRole('button', { name: 'Get New Access Token' }).click();
    // The renderer fetch (https, cert ignored) stores the JWT in the field.
    await expect(
      page.getByPlaceholder('Token will appear here after authorization')
    ).not.toHaveValue('', { timeout: 15_000 });

    await sendButton(page).click();
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/"ok"|"sub"/).first()).toBeVisible();
  });
});
