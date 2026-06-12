import { test, expect } from '../fixtures/servers';
import { switchMode } from '../../e2e/utils/selectors';

/**
 * Desktop MCP: renderer → IPC → mcp-handler → official
 * @modelcontextprotocol/sdk Client (StreamableHTTPClientTransport, pinned
 * fetch) → the SDK's own McpServer fixture. End-to-end validation of the
 * SDK-backed client migration: real initialize handshake, tools discovery,
 * and tool invocation over the live wire.
 */
test.describe('Desktop MCP (official SDK client)', () => {
  test('connect discovers the tool catalog', async ({ app: page, servers }) => {
    await switchMode(page, 'mcp');

    await page.getByPlaceholder('https://mcp.example.com/v1/server').fill(servers.mcp.url);
    await page.getByRole('button', { name: /Connect/i }).click();

    // Reveal the catalog and wait for the discovered tools.
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Tools\s+3/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('echo', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('add', { exact: true }).first()).toBeVisible();

    // The SDK ran the real initialize handshake exactly once, plus discovery.
    expect(servers.mcp.methodsReceived()).toEqual(
      expect.arrayContaining(['initialize', 'tools/list'])
    );
  });
});
