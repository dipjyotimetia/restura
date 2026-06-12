import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/servers';
import { switchMode } from '../../e2e/utils/selectors';

/**
 * Desktop gRPC: renderer → IPC → grpc-handler → ConnectRPC `createGrpcTransport`
 * (native gRPC over h2c) → real @grpc/grpc-js dev server. This is the LIVE
 * transport test the unit suite can't provide (it mocks createGrpcTransport):
 * real HTTP/2 binary framing, trailers, and bidi server reflection.
 */

async function discoverEcho(page: Page, url: string): Promise<void> {
  await switchMode(page, 'grpc');
  await page.getByRole('textbox', { name: 'gRPC server URL' }).fill(url);
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  // Discovery auto-selects the first service/method into the comboboxes.
  await expect(page.getByText('echo.v1.EchoService').first()).toBeVisible({ timeout: 15_000 });
}

async function setRequestMessage(page: Page, json: string): Promise<void> {
  // Tabs accumulate in the shared desktop window, so hidden Monaco instances
  // from other tabs precede this one in the DOM — filter to the visible one.
  // Drive the React onChange directly (typing into Monaco trips auto-closing
  // brackets and corrupts pasted JSON) — same approach as the web helper.
  const editor = page.locator('.monaco-editor').filter({ visible: true }).first();
  const changed = await editor.evaluate((node: Element, value: string) => {
    const host = node.parentElement ?? node;
    const fiberKey = Object.keys(host).find((key) => key.startsWith('__reactFiber$'));
    let fiber: unknown = fiberKey
      ? (host as unknown as Record<string, unknown>)[fiberKey]
      : undefined;
    while (fiber) {
      const props = (fiber as { memoizedProps?: { onChange?: unknown } }).memoizedProps;
      if (typeof props?.onChange === 'function') {
        (props.onChange as (value: string) => void)(value);
        return true;
      }
      fiber = (fiber as { return?: unknown }).return;
    }
    return false;
  }, json);
  if (!changed) throw new Error('Could not reach the Monaco onChange handler');
}

test.describe('Desktop gRPC (native transport)', () => {
  test('Discover lists services via real gRPC reflection', async ({ app: page, servers }) => {
    await discoverEcho(page, servers.grpc.url);
    await expect(page.getByText(/UnaryEcho/).first()).toBeVisible();
  });

  test('unary call round-trips over live HTTP/2', async ({ app: page, servers }) => {
    await discoverEcho(page, servers.grpc.url);

    await setRequestMessage(page, '{"message":"ping","count":1}');
    await page.getByRole('button', { name: /Invoke gRPC method/i }).click();

    await expect(page.getByText(/echo:\s*ping/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('server-streaming yields multiple messages', async ({ app: page, servers }) => {
    await discoverEcho(page, servers.grpc.url);

    // Switch the method combobox from the auto-selected UnaryEcho.
    await page.getByRole('combobox').filter({ hasText: 'UnaryEcho' }).click();
    await page.getByRole('option', { name: 'ServerStreamingEcho' }).click();

    await setRequestMessage(page, '{"message":"tick","count":3}');
    await page.getByRole('button', { name: /Invoke gRPC method/i }).click();

    // Three streamed replies arrive in the Stream tab (badge counts messages).
    const streamTab = page.getByRole('tab', { name: /Stream\s*3/ });
    await expect(streamTab).toBeVisible({ timeout: 15_000 });
    await streamTab.click();
    await expect(page.getByText(/echo:\s*tick/).first()).toBeVisible();
  });
});
