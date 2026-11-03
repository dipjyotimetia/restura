import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { switchMode } from '../../e2e/utils/selectors';
import { expect, test } from '../fixtures/servers';

/**
 * Desktop gRPC protocol-review regressions, end to end: renderer → IPC →
 * grpc-handler → connect-node transport → real HTTP/2 servers.
 *
 *  - a failed unary call shows the server's message (the body was `{}`);
 *  - google.protobuf.Any round-trips over native gRPC;
 *  - the URL path prefix is kept (desktop used to drop it);
 *  - grpc:// URLs and non-PascalCase method names are accepted by the builder.
 */
const ROOT = path.resolve(__dirname, '../..');
const ECHO_PROTO = readFileSync(path.join(ROOT, 'e2e/mocks/proto/echo.proto'), 'utf8');
const EDGE_PROTO = readFileSync(path.join(ROOT, 'e2e/mocks/proto/edge.proto'), 'utf8');
const INNER_ANY = { '@type': 'type.googleapis.com/edge.v1.Inner', x: 'packed' };

async function setRequestMessage(page: Page, json: string): Promise<void> {
  // Same approach as grpc.spec.ts: drive the visible Monaco's React onChange.
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

/** Open a fresh gRPC tab with an uploaded schema and a fully specified call. */
async function prepareCall(
  page: Page,
  call: { url: string; service: string; method: string; body: string; proto: string; name: string }
): Promise<void> {
  await switchMode(page, 'grpc');
  // Request tabs share the window, each with its own hidden file input — go
  // through the visible Upload menu and its file chooser, as a user would.
  await page
    .getByRole('button', { name: /^Upload \.proto/ })
    .filter({ visible: true })
    .first()
    .click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /^Files…/ }).click();
  await (await chooser).setFiles({
    name: call.name,
    mimeType: 'text/plain',
    buffer: Buffer.from(call.proto),
  });
  // The schema landed in THIS tab: its upload button now shows the file name.
  await expect(
    page.getByRole('button', { name: call.name }).filter({ visible: true }).first()
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'gRPC server URL' })
    .filter({ visible: true })
    .fill(call.url);
  await page
    .getByPlaceholder(/Service \(e\.g\./i)
    .filter({ visible: true })
    .fill(call.service);
  await page
    .getByPlaceholder(/Method \(e\.g\./i)
    .filter({ visible: true })
    .fill(call.method);
  await setRequestMessage(page, call.body);
}

async function invoke(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Invoke gRPC method' }).filter({ visible: true });
  await expect(button).toBeEnabled();
  await button.click();
}

test.describe('Desktop gRPC — protocol review regressions', () => {
  test('a failed unary call shows the server message, not `{}`', async ({ app: page, servers }) => {
    await prepareCall(page, {
      url: servers.grpc.url,
      service: 'echo.v1.EchoService',
      method: 'UnaryEcho',
      body: '{"message":"FAIL_PERMISSION_DENIED"}',
      proto: ECHO_PROTO,
      name: 'echo.proto',
    });
    await invoke(page);
    await expect(
      page.getByText('mock-server triggered FAIL_PERMISSION_DENIED').first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test('google.protobuf.Any round-trips over native gRPC', async ({ app: page, servers }) => {
    await prepareCall(page, {
      url: servers.connectGrpc.h2cUrl,
      service: 'edge.v1.EdgeService',
      method: 'Wrap',
      body: JSON.stringify({ note: 'any-desktop', payload: INNER_ANY }),
      proto: EDGE_PROTO,
      name: 'edge.proto',
    });
    await invoke(page);
    // Pretty-printed reply (the editor holds the compact request JSON).
    await expect(page.getByText('"note": "any-desktop"').first()).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText('"@type": "type.googleapis.com/edge.v1.Inner"').first()
    ).toBeVisible();
  });

  test('keeps the URL path prefix over native gRPC', async ({ app: page, servers }) => {
    await prepareCall(page, {
      url: `${servers.connectGrpc.h2cUrl}/api/rpc/`,
      service: 'echo.v1.EchoService',
      method: 'UnaryEcho',
      body: '{"message":"prefixed-desktop"}',
      proto: ECHO_PROTO,
      name: 'echo.proto',
    });
    await invoke(page);
    await expect(page.getByText(/echo:\s*prefixed-desktop/).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('accepts grpc:// URLs and non-PascalCase methods', async ({ app: page, servers }) => {
    await prepareCall(page, {
      url: servers.connectGrpc.h2cUrl.replace(/^http:/, 'grpc:'),
      service: 'edge.v1.EdgeService',
      method: 'get_item',
      body: '{"note":"lower"}',
      proto: EDGE_PROTO,
      name: 'edge.proto',
    });
    await invoke(page);
    await expect(page.getByText('got lower').first()).toBeVisible({ timeout: 15_000 });
  });
});
