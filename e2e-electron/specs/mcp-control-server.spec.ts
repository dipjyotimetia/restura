/**
 * Desktop MCP control server, end to end (ADR 0041):
 *
 *   MCP SDK client (the "agent")
 *     ──stdio──► a second Electron process launched as `Restura --mcp-server` (the shim)
 *     ──HTTP 127.0.0.1 + bearer token (from the 0600 handshake file)──► running app main
 *     ──IPC──► renderer tool runtime (consent + approval dialogs + real stores)
 *     ──collection runner──► real local HTTP server
 *
 * The agent builds a collection, an environment and a request, then sends it,
 * while the test plays the user: granting access in Settings and clicking
 * Approve / Deny on the approval dialogs.
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Page } from '@playwright/test';
import electronBinary from 'electron';
import { expect, test } from '../fixtures/servers';

const ROOT = path.resolve(__dirname, '../..');
const MAIN_JS = path.join(ROOT, 'dist/electron/electron/main/main.js');

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
const text = (r: ToolResult) => r.content[0]?.text ?? '';
const json = <T>(r: ToolResult): T => JSON.parse(text(r)) as T;

async function openMcpSettings(page: Page) {
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'MCP Server' }).click();
  await expect(page.getByRole('heading', { name: 'MCP server' })).toBeVisible();
}

async function closeSettings(page: Page) {
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('heading', { name: 'MCP server' })).toBeHidden();
}

async function chooseLevel(page: Page, ariaLabel: string, option: string) {
  await page.getByRole('combobox', { name: ariaLabel }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Run a tool call while the test answers the approval dialog. */
async function approved(page: Page, pending: Promise<unknown>, button = /^(Apply|Send|Delete)$/) {
  const dialog = page.getByTestId('mcp-approval-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: button }).click();
  return (await pending) as ToolResult;
}

test.describe('Desktop MCP control server', () => {
  test('an agent builds, configures and sends a request through the stdio shim', async ({
    app: page,
    servers,
    electronProfileDirectory,
  }) => {
    test.setTimeout(120_000);

    // --- user turns the server on --------------------------------------
    await openMcpSettings(page);
    await page.getByRole('switch', { name: 'Enable MCP server' }).click();
    await expect(page.getByTestId('mcp-server-status')).toContainText('Listening on 127.0.0.1:');
    await expect(page.getByTestId('mcp-config-claude-code')).toContainText('--mcp-server');
    await closeSettings(page);

    // --- the agent launches Restura as a stdio MCP server ----------------
    const agent = new Client({ name: 'e2e-agent', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: electronBinary as unknown as string,
      // Playwright's _electron.launch adds --no-sandbox on Linux for the app;
      // this second Electron process needs the same, or it dies at startup on
      // runners that restrict unprivileged user namespaces (Ubuntu 24.04).
      args: [MAIN_JS, '--mcp-server', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
      cwd: ROOT,
      env: {
        ...(process.env as Record<string, string>),
        NODE_ENV: 'production',
        RESTURA_USER_DATA_DIR: electronProfileDirectory,
        RESTURA_DISABLE_AUTO_UPDATE: 'true',
      },
      stderr: 'pipe',
    });
    // Keep the shim's stderr so a crash at startup explains itself.
    let shimStderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      shimStderr = (shimStderr + chunk.toString()).slice(-8_000);
    });
    try {
      await agent.connect(transport);
    } catch (err) {
      throw new Error(`The --mcp-server shim did not start: ${String(err)}\n${shimStderr}`);
    }
    try {
      const { tools } = await agent.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['create_collection', 'create_request', 'send_request'])
      );

      // Nothing is shared yet: the agent sees nothing and cannot create.
      const access = json<{ collections: { readable: number } }>(
        (await agent.callTool({ name: 'describe_access', arguments: {} })) as ToolResult
      );
      expect(access.collections.readable).toBe(0);
      const refused = (await agent.callTool({
        name: 'create_collection',
        arguments: { name: 'Agent API' },
      })) as ToolResult;
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/Settings → MCP Server/);
      await expect(page.getByTestId('mcp-approval-dialog')).toBeHidden();

      // --- user grants edit access by default -----------------------------
      await openMcpSettings(page);
      await chooseLevel(page, 'Default access for collections', 'Read & edit');
      await closeSettings(page);

      // --- agent creates a collection (user approves in the dialog) -------
      const created = await approved(
        page,
        agent.callTool({ name: 'create_collection', arguments: { name: 'Agent API' } })
      );
      expect(created.isError).toBeFalsy();
      const { collectionId } = json<{ collectionId: string }>(created);
      await expect(page.getByText('Agent API').first()).toBeVisible();

      // Environment needs an environment edit grant first.
      const envRefused = (await agent.callTool({
        name: 'create_environment',
        arguments: { name: 'local' },
      })) as ToolResult;
      expect(envRefused.isError).toBe(true);

      // --- agent adds a request with a test script ------------------------
      const request = await approved(
        page,
        agent.callTool({
          name: 'create_request',
          arguments: {
            collectionId,
            request: {
              type: 'http',
              name: 'Get JSON',
              method: 'GET',
              url: `${servers.http.url}/json`,
              testScript: "rs.test('status is 200', () => rs.response.to.have.status(200));",
            },
          },
        })
      );
      const { requestId } = json<{ requestId: string }>(request);
      await expect(page.getByText('Get JSON').first()).toBeVisible();

      // Sending needs "Full" access: refused without a dialog.
      const sendRefused = (await agent.callTool({
        name: 'send_request',
        arguments: { requestId },
      })) as ToolResult;
      expect(sendRefused.isError).toBe(true);
      expect(text(sendRefused)).toMatch(/Full/);

      // --- user grants Full on that collection ---------------------------
      await openMcpSettings(page);
      await chooseLevel(page, 'Agent access for collection Agent API', 'Full (send)');
      await closeSettings(page);

      // --- a denied send never reaches the server -------------------------
      const before = servers.http.requestCount();
      const deniedSend = agent.callTool({ name: 'send_request', arguments: { requestId } });
      const dialog = page.getByTestId('mcp-approval-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`GET ${servers.http.url}/json`);
      await dialog.getByRole('button', { name: 'Deny' }).click();
      const denied = (await deniedSend) as ToolResult;
      expect(denied.isError).toBe(true);
      expect(text(denied)).toMatch(/denied/);
      expect(servers.http.requestCount()).toBe(before);

      // --- an approved send goes through the real pipeline ----------------
      const sent = await approved(
        page,
        agent.callTool({ name: 'send_request', arguments: { requestId } }),
        /^Send$/
      );
      expect(sent.isError).toBeFalsy();
      const result = json<{
        status: string;
        tests: Array<{ name: string; passed: boolean }>;
        response: { status: number; untrustedContent: { body: string } };
      }>(sent);
      expect(result.status).toBe('success');
      expect(result.response.status).toBe(200);
      expect(result.response.untrustedContent.body).toContain('hello');
      expect(result.tests).toEqual([{ name: 'status is 200', passed: true }]);
      expect(servers.http.requests().some((r) => r.path === '/json')).toBe(true);

      // --- the user sees every change in the activity log ------------------
      await openMcpSettings(page);
      const log = page.getByTestId('mcp-activity');
      await expect(log).toContainText('Sent “Get JSON” → 200');
      await expect(log).toContainText('Created request “Get JSON”');
      await expect(log).toContainText('Created collection “Agent API”');

      // --- turning the server off cuts the agent off -----------------------
      await page.getByRole('switch', { name: 'Enable MCP server' }).click();
      await expect(page.getByTestId('mcp-server-status')).toBeHidden();
      await closeSettings(page);
      const off = (await agent.callTool({ name: 'describe_access', arguments: {} })) as ToolResult;
      expect(off.isError).toBe(true);
      expect(text(off)).toMatch(/not running, or its MCP server is turned off/);
    } finally {
      await agent.close();
    }
  });
});
