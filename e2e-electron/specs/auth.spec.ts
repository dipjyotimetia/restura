import { test, expect } from '../fixtures/echoLocal';
import type { Page } from '@playwright/test';
import { switchMode, setUrl, sendButton } from '../../e2e/utils/selectors';

/**
 * Desktop wire-level auth signing. The renderer configures auth; the actual
 * signing happens in the Electron main process (auth-applier.ts / the shared
 * auth signers) against the exact upstream bytes — a path the web e2e suite
 * (which signs through the Worker) never exercises. echo-local's HTTP server
 * carries the full auth surface and *verifies* the credential, returning 401 on
 * failure and `{ authenticated: true, … }` on success. So asserting a 200 here
 * proves the desktop client signed the request correctly.
 */

const USER = { username: 'alice', password: 'wonderland' };
const AWS = {
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'execute-api',
};

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
    await page.getByPlaceholder('Enter bearer token').fill('echo-local-token');
    await sendButton(page).click();
    await expectAuthenticated(page);
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
});
