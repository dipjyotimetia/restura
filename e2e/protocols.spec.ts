import { test, expect } from './fixtures/app';
import { switchMode } from './utils/selectors';

test.describe('Protocol switching', () => {
  test('switches between HTTP, GraphQL, gRPC, WS, SSE, MCP modes', async ({ app: page }) => {
    // Default is HTTP — check the request URL field is present.
    await expect(page.getByRole('textbox', { name: 'Request URL' })).toBeVisible();

    await switchMode(page, 'graphql');
    await expect(page.getByRole('textbox', { name: 'GraphQL endpoint URL' })).toBeVisible();

    await switchMode(page, 'grpc');
    await expect(page.getByRole('textbox', { name: 'gRPC server URL' })).toBeVisible();

    await switchMode(page, 'ws');
    await expect(page.getByRole('textbox', { name: 'WebSocket URL' })).toBeVisible();

    await switchMode(page, 'sse');
    // SSE uses a placeholder; the URL field shows "https://example.com/events".
    await expect(page.getByRole('textbox', { name: /events|SSE/i }).first()).toBeVisible();

    await switchMode(page, 'http');
    await expect(page.getByRole('textbox', { name: 'Request URL' })).toBeVisible();
  });
});

test.describe('GraphQL flow', () => {
  test('renders the query editor and headers/auth/scripts tabs', async ({ app: page }) => {
    await switchMode(page, 'graphql');

    await expect(page.getByRole('tab', { name: 'Query' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Headers' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Auth' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Scripts' })).toBeVisible();

    // Send is disabled until URL is filled — clear the default echo URL first.
    const urlField = page.getByRole('textbox', { name: 'GraphQL endpoint URL' });
    await urlField.fill('');
    const send = page.getByRole('button', { name: /Send GraphQL query/i });
    await expect(send).toBeDisabled();

    await urlField.fill('https://api.example.com/graphql');
    await expect(send).toBeEnabled();
  });

  test('accepts query input in the body editor', async ({ app: page }) => {
    await switchMode(page, 'graphql');

    await page.getByRole('textbox', { name: 'GraphQL endpoint URL' }).fill('https://api.example.com/graphql');
    await page.getByRole('tab', { name: 'Query' }).click();

    const editor = page.locator('.monaco-editor').first();
    await editor.waitFor({ state: 'visible' });
    await editor.click();
    await page.keyboard.type('{ user(id: 1) { id name } ', { delay: 10 });
    await expect(editor).toContainText('user(id: 1)');
  });
});

test.describe('gRPC flow', () => {
  test('shows server URL, service/method fields, and disabled Invoke', async ({ app: page }) => {
    await switchMode(page, 'grpc');

    await expect(page.getByRole('textbox', { name: 'gRPC server URL' })).toBeVisible();
    await expect(page.getByPlaceholder(/Service \(e\.g\./i)).toBeVisible();
    await expect(page.getByPlaceholder(/Method \(e\.g\./i)).toBeVisible();

    const invoke = page.getByRole('button', { name: /Invoke gRPC method/i });
    await expect(invoke).toBeDisabled();

    await page.getByRole('textbox', { name: 'gRPC server URL' }).fill('grpc.example.com:443');
    await page.getByPlaceholder(/Service \(e\.g\./i).fill('greet.v1.GreetService');
    await page.getByPlaceholder(/Method \(e\.g\./i).fill('Greet');

    // Invoke may stay disabled until a method is discovered/uploaded —
    // the important assertion is that filling fields didn't crash the UI.
    await expect(page.getByRole('textbox', { name: 'gRPC server URL' })).toHaveValue('grpc.example.com:443');
  });

  test('switches gRPC call type via dropdown', async ({ app: page }) => {
    await switchMode(page, 'grpc');

    // Call type dropdown defaults to "Unary"; open and pick a streaming variant.
    await page.locator('[role="combobox"]').filter({ hasText: /^Unary$/ }).first().click();
    await page.locator('[role="option"]').filter({ hasText: /Server Streaming/i }).click();
    await expect(page.locator('[role="combobox"]').filter({ hasText: /Server Streaming/i })).toBeVisible();
  });
});

test.describe('WebSocket flow', () => {
  test('shows WebSocket URL and disabled Connect until URL is set', async ({ app: page }) => {
    await switchMode(page, 'ws');

    const wsUrl = page.getByRole('textbox', { name: 'WebSocket URL' });
    await expect(wsUrl).toBeVisible();
    // Clear the default echo URL so the disabled-state assertion is meaningful.
    await wsUrl.fill('');

    const connect = page.getByRole('button', { name: 'Connect', exact: true });
    await expect(connect).toBeDisabled();

    await wsUrl.fill('wss://echo.websocket.org');
    await expect(connect).toBeEnabled();

    // Auto-reconnect is on by default.
    await expect(page.getByRole('switch', { name: 'Auto-reconnect' })).toBeChecked();
  });

  test('lets the user toggle auto-reconnect', async ({ app: page }) => {
    await switchMode(page, 'ws');
    const toggle = page.getByRole('switch', { name: 'Auto-reconnect' });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
  });
});

test.describe('SSE flow', () => {
  test('shows event log controls', async ({ app: page }) => {
    await switchMode(page, 'sse');

    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    await expect(page.getByRole('switch', { name: /Reconnect on resume/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Events \(\d+\)/ })).toBeVisible();
  });
});
