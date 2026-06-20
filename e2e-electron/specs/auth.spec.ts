import { test, expect } from '../fixtures/echoLocal';
import type { Page } from '@playwright/test';
import { switchMode, setUrl, sendButton } from '../../e2e/utils/selectors';
import { TEST_AUTH_FIXTURES } from '../../e2e/mocks/authRoutes';

/**
 * Desktop wire-level auth signing. The renderer configures auth; the actual
 * signing happens in the Electron main process (auth-applier.ts / the shared
 * auth signers) against the exact upstream bytes — a path the web e2e suite
 * (which signs through the Worker) never exercises. echo-local's HTTP server
 * carries the full auth surface and *verifies* the credential, returning 401 on
 * failure and `{ authenticated: true, … }` on success. So asserting a 200 here
 * proves the desktop client signed the request correctly.
 */

// Source the credentials from the same fixtures the mock servers validate
// against, so a rename can never silently desync the spec from the server.
const USER = TEST_AUTH_FIXTURES.user;
const AWS = TEST_AUTH_FIXTURES.aws;
const BEARER_TOKEN = TEST_AUTH_FIXTURES.bearer.token;
const OAUTH1 = TEST_AUTH_FIXTURES.oauth1;

/** Open the Auth tab and pick an auth type from the left-rail picker. */
async function chooseAuth(page: Page, label: string): Promise<void> {
  await page.getByRole('tab', { name: 'Auth', exact: true }).click();
  await page.getByRole('button', { name: label, exact: true }).click();
}

async function expectAuthenticated(page: Page): Promise<void> {
  await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/"authenticated"/).first()).toBeVisible();
}

test.describe('Desktop HTTP auth signing (echo-local)', () => {
  test('Bearer token authenticates', async ({ app: page, echo }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${echo.httpUrl}/bearer`);
    await chooseAuth(page, 'Bearer');
    await page.getByPlaceholder('Enter bearer token').fill(BEARER_TOKEN);
    await sendButton(page).click();
    await expectAuthenticated(page);
  });

  // Negative case: the mock is fail-closed (verifies the exact token), so a
  // wrong token must be rejected. Without this, the positive test above is
  // decorative — it would pass even if the client sent a garbage token.
  test('a wrong Bearer token is rejected (fail-closed)', async ({ app: page, echo }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${echo.httpUrl}/bearer`);
    await chooseAuth(page, 'Bearer');
    await page.getByPlaceholder('Enter bearer token').fill('not-the-real-token');
    await sendButton(page).click();
    await expect(page.getByText('401', { exact: true }).first()).toBeVisible();
  });

  test('Basic auth signs base64 credentials', async ({ app: page, echo }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${echo.httpUrl}/basic-auth/${USER.username}/${USER.password}`);
    await chooseAuth(page, 'Basic');
    await page.getByPlaceholder('Enter username').fill(USER.username);
    await page.getByPlaceholder('Enter password').fill(USER.password);
    await sendButton(page).click();
    await expectAuthenticated(page);
  });

  test('API key in a custom header authenticates', async ({ app: page, echo }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${echo.httpUrl}/api-key/header/X-API-Key/secret123`);
    await chooseAuth(page, 'API Key');
    await page.getByPlaceholder('e.g., X-API-Key').fill('X-API-Key');
    await page.getByPlaceholder('Enter API key value').fill('secret123');
    await sendButton(page).click();
    await expectAuthenticated(page);
    await expect(page.getByText(/"via"/).first()).toBeVisible();
  });

  // Sign-at-wire auth: the renderer forwards the descriptor and the Electron
  // main process signs at the wire (shared applyAuth → signSigV4). echo-local
  // recomputes and verifies the signature, returning 200 only when it matches —
  // so this exercises the real desktop SigV4 path end-to-end.
  test('AWS SigV4 signature is accepted', async ({ app: page, echo }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${echo.httpUrl}/aws/protected`);
    await chooseAuth(page, 'AWS Sig v4');
    await page.getByPlaceholder('Enter AWS access key').fill(AWS.accessKey);
    await page.getByPlaceholder('Enter AWS secret key').fill(AWS.secretKey);
    await page.getByPlaceholder('e.g., us-east-1').fill(AWS.region);
    await page.getByPlaceholder('e.g., execute-api').fill(AWS.service);
    await sendButton(page).click();
    await expectAuthenticated(page);
    // The access key is echoed back only when the signature verifies.
    await expect(page.getByText(/AKIDEXAMPLE/).first()).toBeVisible();
  });

  // A second sign-at-wire type (signed in the main process by buildWsseHeader,
  // not in the renderer) — confirms the desktop forwards the auth descriptor for
  // the whole sign-at-wire family, not just AWS SigV4. echo verifies the digest.
  test('WSSE digest is accepted', async ({ app: page, echo }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${echo.httpUrl}/wsse/protected`);
    await chooseAuth(page, 'WSSE');
    await page.getByPlaceholder('Enter username').fill(USER.username);
    await page.getByPlaceholder('Enter password').fill(USER.password);
    await sendButton(page).click();
    await expectAuthenticated(page);
  });

  // OAuth 1.0a — the third sign-at-wire family member, and previously the
  // highest-risk gap: the client has real HMAC-SHA1 wire-signing
  // (buildOAuth1Header) but nothing verified it. /oauth1/protected recomputes
  // the signature with an INDEPENDENT RFC 5849 verifier (validated against the
  // RFC worked example, not the signer's code), so a 200 proves the desktop
  // OAuth1 signing is genuinely RFC-correct end-to-end.
  test('OAuth 1.0 (HMAC-SHA1) signature is accepted', async ({ app: page, echo }) => {
    await switchMode(page, 'http');
    await setUrl(page, `${echo.httpUrl}/oauth1/protected`);
    await chooseAuth(page, 'OAuth 1.0');
    await page.getByPlaceholder('Enter consumer key').fill(OAUTH1.consumerKey);
    await page.getByPlaceholder('Enter consumer secret').fill(OAUTH1.consumerSecret);
    // 'Enter access token' is a substring of 'Enter access token secret' — exact.
    await page.getByPlaceholder('Enter access token', { exact: true }).fill(OAUTH1.accessToken);
    await page
      .getByPlaceholder('Enter access token secret', { exact: true })
      .fill(OAUTH1.accessTokenSecret);
    await sendButton(page).click();
    await expectAuthenticated(page);
    // The consumer key is echoed back only when the signature verifies.
    await expect(page.getByText(new RegExp(OAUTH1.consumerKey)).first()).toBeVisible();
  });
});
