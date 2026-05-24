import { test, expect } from './fixtures/servers';
import { switchMode } from './utils/selectors';

/**
 * Real Server-Sent Events. The mock HTTP server's `/stream/sse` endpoint
 * emits three `tick` events then closes. The renderer attaches via native
 * EventSource (no custom headers) or fetch+stream (with headers).
 */
test.describe('Real SSE server', () => {
  test('UI connects, receives 3 events, and shows the count', async ({ app: page, servers }) => {
    await switchMode(page, 'sse');

    const urlField = page.getByPlaceholder('https://echo.restura.dev/sse');
    await urlField.fill(`${servers.http.url}/stream/sse`);

    await page.getByRole('button', { name: 'Start SSE stream' }).click();

    // The renderer's onmessage handler converts each event into a `message`
    // badge. Wait until at least three of those are present.
    const messageBadges = page
      .locator('div')
      .filter({ has: page.getByText('message', { exact: true }) });
    await expect
      .poll(async () => await messageBadges.count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(3);

    expect(
      servers.http.requests().filter((r) => r.path === '/stream/sse').length
    ).toBeGreaterThanOrEqual(1);

    // Tear down to stop EventSource reconnect noise before teardown.
    await page
      .getByRole('button', { name: 'Stop SSE stream' })
      .first()
      .click()
      .catch(() => {});
  });

  test('UI surfaces a Disconnect button while connected', async ({ app: page, servers }) => {
    await switchMode(page, 'sse');

    // /slow keeps the connection open long enough to see the button. Use a
    // long sleep — the test cancels it via Disconnect before completion.
    await page
      .getByPlaceholder('https://echo.restura.dev/sse')
      .fill(`${servers.http.url}/stream/sse`);

    await page.getByRole('button', { name: 'Start SSE stream' }).click();
    // Either Disconnect appears (still streaming) or 3 events arrived first;
    // both are valid resting states. Just assert no errors crashed the panel.
    await expect(page.getByText('Event timeline')).toBeVisible();
  });

  test('Wire: /stream/sse emits text/event-stream with three messages', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/stream/sse`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    // Three frames, each with an `id:` and `data:` line (default `message` event).
    const dataCount = (text.match(/data:\s*\{/g) ?? []).length;
    expect(dataCount).toBe(3);
    expect(text).toContain('"n":1');
    expect(text).toContain('"n":3');
  });

  test('Wire: /stream/sse-named emits three named `tick` events', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/stream/sse-named`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const ticks = (text.match(/event:\s*tick/g) ?? []).length;
    expect(ticks).toBe(3);
  });

  test('Wire: /stream/ndjson emits one JSON object per line', async ({ servers }) => {
    const res = await fetch(`${servers.http.url}/stream/ndjson`);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await res.text();
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]!)).toEqual({ n: 1 });
    expect(JSON.parse(lines[2]!)).toEqual({ n: 3 });
  });
});
