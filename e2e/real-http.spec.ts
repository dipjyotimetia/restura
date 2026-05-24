import { test, expect } from './fixtures/servers';
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

/**
 * End-to-end tests against a real local HTTP server. The renderer makes real
 * network calls to `http://127.0.0.1:<port>` — no Playwright route mocking.
 *
 * This validates the actual axios path, request building, response parsing,
 * and UI rendering against bytes that came off a real socket.
 */
test.describe('Real HTTP server', () => {
  test('GET /json returns 200 with body', async ({ app: page, servers }) => {
    await setUrl(page, `${servers.http.url}/json`);
    await sendButton(page).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/"hello"/).first()).toBeVisible();
    expect(servers.http.requestCount()).toBe(1);
    const last = servers.http.requests()[0];
    expect(last?.method).toBe('GET');
    expect(last?.path).toBe('/json');
  });

  test('POST /echo with JSON body round-trips through the wire', async ({ app: page, servers }) => {
    await selectHttpMethod(page, 'POST');

    await setUrl(page, `${servers.http.url}/echo`);

    await bodyTab(page).click();
    await selectBodyType(page, 'JSON');
    await fillFirstMonacoEditor(page, '{"name":"Ada","age":30}');

    await sendButton(page).click();
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();

    expect(servers.http.requestCount()).toBe(1);
    const recorded = servers.http.requests()[0];
    expect(recorded?.method).toBe('POST');
    expect(recorded?.body).toContain('"name":"Ada"');
    expect(recorded?.body).toContain('"age":30');
  });

  test('query params and custom header are sent on the wire', async ({ app: page, servers }) => {
    await setUrl(page, `${servers.http.url}/echo`);

    await paramsTab(page).click();
    await page.getByRole('button', { name: /Add parameter/i }).click();
    await page.getByPlaceholder('key').first().fill('q');
    await page.getByPlaceholder('value').first().fill('hello world');

    await headersTab(page).click();
    await page.getByRole('button', { name: /Add header/i }).click();
    await page.getByPlaceholder('key').last().fill('X-Test');
    await page.getByPlaceholder('value').last().fill('yes');

    await sendButton(page).click();
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();

    const recorded = servers.http.requests()[0];
    expect(recorded?.path).toContain('q=hello');
    const headers = recorded?.headers ?? {};
    expect(headers['x-test']).toBe('yes');
  });

  test('renders 404 from real server', async ({ app: page, servers }) => {
    await setUrl(page, `${servers.http.url}/status/404`);
    await sendButton(page).click();

    await expect(page.getByText('404', { exact: true }).first()).toBeVisible();
    expect(servers.http.requestCount()).toBe(1);
  });

  test('renders 500 from real server', async ({ app: page, servers }) => {
    await setUrl(page, `${servers.http.url}/status/500`);
    await sendButton(page).click();

    await expect(page.getByText('500', { exact: true }).first()).toBeVisible();
  });

  test('handles a slow response', async ({ app: page, servers }) => {
    await setUrl(page, `${servers.http.url}/slow?ms=400`);
    await sendButton(page).click();

    await expect(page.getByText('200', { exact: true }).first()).toBeVisible({ timeout: 8000 });
    const recorded = servers.http.requests()[0];
    expect(recorded?.path).toBe('/slow?ms=400');
  });
});
