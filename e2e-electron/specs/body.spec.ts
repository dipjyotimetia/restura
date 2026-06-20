import { test, expect } from '../fixtures/servers';
import { switchMode, setUrl, sendButton, selectHttpMethod } from '../../e2e/utils/selectors';

/**
 * Desktop multipart form-data send on the INTERACTIVE Send path
 * (useHttpRequestPage → IPC → http-handler → undici). Regression guard for a
 * real, previously-undetected bug: the interactive path hard-coded
 * `bodyType: 'raw'` and forwarded only `body.raw`, silently dropping
 * `body.formData`. The collection/workflow path (requestExecutor) built the
 * multipart body correctly, so the divergence only bit the most-used button.
 *
 * echo-local's `/upload` REJECTS a non-multipart request with 400 and echoes
 * the parsed field names on success — so asserting 200 + the field name + a
 * boundary'd content-type on the recorded request proves a real multipart body
 * reached the wire (fail-closed; the pre-fix path produced a 400).
 */
test.describe('Desktop HTTP form-data body', () => {
  test('multipart fields reach the wire from the interactive page', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'http');
    await selectHttpMethod(page, 'POST');
    await setUrl(page, `${servers.http.url}/upload`);

    await page.getByRole('tab', { name: 'Body', exact: true }).click();
    await page
      .getByRole('radio', { name: 'form-data', exact: true })
      .filter({ visible: true })
      .first()
      .click();

    await page.getByRole('button', { name: 'Add field' }).filter({ visible: true }).first().click();
    await page.getByLabel('Field key').filter({ visible: true }).first().fill('greeting');
    await page.getByLabel('Field value').filter({ visible: true }).first().fill('hello-multipart');

    await sendButton(page).click();

    // 200 + echoed field name only happens when a real multipart body arrived;
    // the pre-fix interactive path sent bodyType:'raw' with empty data → 400.
    await expect(page.getByText('200', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/greeting/).first()).toBeVisible();

    // Wire-level proof, independent of how the response renders.
    const upload = servers.http.requests().find((r) => r.path === '/upload');
    expect(upload?.method).toBe('POST');
    expect(String(upload?.headers['content-type'])).toMatch(/multipart\/form-data;\s*boundary=/);
    expect(upload?.body).toContain('greeting');
    expect(upload?.body).toContain('hello-multipart');
  });
});
