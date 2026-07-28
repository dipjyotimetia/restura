import { test, expect } from '../fixtures/servers';
import { switchMode } from '../../e2e/utils/selectors';

async function showCatalog(page: Parameters<typeof switchMode>[0]): Promise<void> {
  const catalog = page.getByRole('button', { name: 'Tools', exact: true });
  if ((await catalog.getAttribute('aria-pressed')) !== 'true') await catalog.click();
}

/**
 * Desktop MCP: renderer → IPC → mcp-handler → official
 * @modelcontextprotocol/sdk Client (StreamableHTTPClientTransport, pinned
 * fetch) → the SDK's own McpServer fixture. End-to-end validation of the
 * SDK-backed client migration: real initialize handshake, tools discovery,
 * and tool invocation over the live wire.
 */
test.describe('Desktop MCP (official SDK client)', () => {
  test.afterEach(async ({ app: page }) => {
    const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
    if (await disconnect.isVisible().catch(() => false)) await disconnect.click();
  });

  test('connect discovers the tool catalog', async ({ app: page, servers }) => {
    await switchMode(page, 'mcp');

    await page.getByPlaceholder('https://mcp.example.com/v1/server').fill(servers.mcp.url);
    await page.getByRole('button', { name: /Connect/i }).click();

    // Reveal the catalog and wait for the discovered tools.
    await showCatalog(page);
    await expect(page.getByRole('tab', { name: /Tools\s+3/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('echo', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('add', { exact: true }).first()).toBeVisible();

    // The SDK ran the real initialize handshake exactly once, plus discovery.
    expect(servers.mcp.methodsReceived()).toEqual(
      expect.arrayContaining(['initialize', 'tools/list'])
    );
  });

  test('connects to the modern v2 mock and exposes its extended catalog', async ({
    app: page,
    servers,
  }) => {
    await switchMode(page, 'mcp');

    await page.getByPlaceholder('https://mcp.example.com/v1/server').fill(servers.mcpV2.url);
    await page.getByRole('button', { name: /Connect/i }).click();

    await showCatalog(page);
    await expect(page.getByRole('tab', { name: /Tools\s+5/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('confirm-deploy', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('header-echo', { exact: true }).first()).toBeVisible();
  });
});
