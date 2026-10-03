import { sendButton, setUrl, switchMode } from '../../e2e/utils/selectors';
import { expect, test } from '../fixtures/servers';

/**
 * Desktop measures connection phases on direct connections. The local server
 * is an IP literal (no DNS lookup), so the breakdown shows Connect (plain
 * HTTP, no TLS), Waiting and Download, but no DNS row.
 */
test('Timeline shows the measured connection breakdown', async ({ app: page, servers }) => {
  await switchMode(page, 'http');
  await setUrl(page, `${servers.http.url}/json`);
  await sendButton(page).click();
  await expect(page.getByText('200', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText('Opening the TCP connection.', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Request sent until the response headers arrived/)).toBeVisible();
  await expect(page.getByText('Resolving the host name.')).toHaveCount(0);
});

test('a hostname adds a DNS phase', async ({ app: page, servers }) => {
  await switchMode(page, 'http');
  await setUrl(page, `${servers.http.url.replace('127.0.0.1', 'localhost')}/json`);
  await sendButton(page).click();
  await expect(page.getByText('200', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText('Resolving the host name.', { exact: true })).toBeVisible();
  await expect(page.getByText('Opening the TCP connection.', { exact: true })).toBeVisible();
});
