import { TEST_AUTH_FIXTURES } from '../../e2e/mocks/authRoutes';
import { sendButton, setUrl, switchMode } from '../../e2e/utils/selectors';
import { expect, test } from '../fixtures/tls';

/**
 * Desktop OAuth 2.0 (client-credentials), end-to-end. The token is fetched
 * through the app transport (`http:request` IPC, like the API call itself) with
 * the open request's TLS settings, so turning SSL verification off for this
 * request also lets the token request accept the https mock's private-CA leaf.
 * The acquired JWT is then applied as a bearer on the normal IPC send to
 * /oauth/protected. A 200 proves fetch-token → apply → verify.
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
    // The token request (IPC, verifySsl off like the request) stores the JWT.
    await expect(
      page.getByPlaceholder('Token will appear here after authorization')
    ).not.toHaveValue('', { timeout: 15_000 });

    await sendButton(page).click();
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/"ok"|"sub"/).first()).toBeVisible();
  });
});
