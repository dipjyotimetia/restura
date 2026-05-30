import { test, expect } from './fixtures/app';
import { mockProxy } from './utils/mockProxy';
import {
  setUrl,
  sendButton,
  selectHttpMethod,
  selectBodyType,
  fillFirstMonacoEditor,
  headersTab,
  bodyTab,
  paramsTab,
} from './utils/selectors';

test.describe('HTTP request flow', () => {
  test('sends GET and renders status, body, headers', async ({ app: page }) => {
    await mockProxy(page, ({ method }) => ({
      status: method === 'GET' ? 200 : 405,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', 'x-mock': 'true' },
      body: JSON.stringify({ ok: true, hello: 'world' }),
    }));

    await setUrl(page, 'https://api.example.com/users/1');
    await sendButton(page).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('"hello"').first()).toBeVisible();
  });

  test('switches method to POST and sends a JSON body', async ({ app: page }) => {
    let capturedBody: string | undefined;
    let capturedMethod: string | undefined;
    await mockProxy(page, ({ method, body }) => {
      capturedMethod = method;
      capturedBody = body;
      return {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 42 }),
      };
    });

    await selectHttpMethod(page, 'POST');

    await setUrl(page, 'https://api.example.com/users');

    await bodyTab(page).click();
    await selectBodyType(page, 'JSON');
    await fillFirstMonacoEditor(page, '{"name":"Ada"}');

    await sendButton(page).click();

    await expect(page.getByText('201', { exact: true }).first()).toBeVisible();
    expect(capturedMethod).toBe('POST');
    expect(capturedBody ?? '').toContain('Ada');
  });

  test('adds a query param and a custom header', async ({ app: page }) => {
    let capturedHeaders: Record<string, string> = {};
    let capturedUrl = '';
    await mockProxy(page, ({ url, headers }) => {
      capturedUrl = url;
      capturedHeaders = headers;
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pong: true }),
      };
    });

    await setUrl(page, 'https://api.example.com/ping');

    await paramsTab(page).click();
    await page.getByRole('button', { name: /Add row/i }).click();
    await page.getByPlaceholder('key').first().fill('q');
    await page.getByPlaceholder('value').first().fill('hello world');

    await headersTab(page).click();
    await page.getByRole('button', { name: /Add row/i }).click();
    await page.getByPlaceholder('key').first().fill('X-Test');
    await page.getByPlaceholder('value').first().fill('yes');

    await sendButton(page).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    expect(capturedUrl).toContain('q=hello');
    expect(Object.keys(capturedHeaders).map((k) => k.toLowerCase())).toContain('x-test');
  });

  test('renders 4xx error response without crashing', async ({ app: page }) => {
    await mockProxy(page, () => ({
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'gone' }),
    }));

    await setUrl(page, 'https://api.example.com/missing');
    await sendButton(page).click();
    await expect(page.getByText('404', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('"error"').first()).toBeVisible();
  });

  test('disables Send when URL is empty', async ({ app: page }) => {
    await setUrl(page, '');
    await expect(sendButton(page)).toBeDisabled();
    await setUrl(page, 'https://api.example.com/x');
    await expect(sendButton(page)).toBeEnabled();
  });
});
