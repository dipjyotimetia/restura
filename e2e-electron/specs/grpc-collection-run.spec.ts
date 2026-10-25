import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/servers';

/**
 * #871 — the desktop collection runner executes saved unary gRPC requests over
 * the LIVE native transport (renderer → IPC → grpc-handler → real
 * @grpc/grpc-js dev server):
 *
 *  - "proto snapshot": the request's schema travels in the OpenCollection
 *    `x-restura-grpc` extension (deduped by sha-256), is re-inlined on import
 *    and handed to the runner via protocolOptions — no reflection needed.
 *  - "no snapshot": the runner falls back to server reflection.
 */

const PROTO = readFileSync(resolve(process.cwd(), 'e2e/mocks/proto/echo.proto'), 'utf8');
const NAME = 'gRPC Runner E2E';
const PROTO_HASH = 'e2e-proto-snapshot'; // any key works; import resolves by reference

function buildCollection(grpcUrl: string): Buffer {
  const item = (name: string, message: string) => ({
    info: { type: 'grpc', name },
    grpc: {
      url: grpcUrl,
      service: 'echo.v1.EchoService',
      method: 'UnaryEcho',
      methodType: 'unary',
      message,
    },
  });
  const oc = {
    opencollection: '1.0.0',
    info: { name: NAME },
    items: [
      item('Echo via proto snapshot', '{"message":"snap"}'),
      item('Echo via reflection fallback', '{"message":"refl"}'),
    ],
    extensions: {
      'x-restura-grpc': {
        schemas: { [PROTO_HASH]: { kind: 'proto', fileName: 'echo.proto', text: PROTO } },
        requests: [{ path: ['Echo via proto snapshot'], schema: PROTO_HASH, timeout: 10_000 }],
      },
    },
  };
  // JSON is valid YAML; the OpenCollection importer accepts either.
  return Buffer.from(JSON.stringify(oc), 'utf8');
}

async function importCollection(page: Page, buffer: Buffer): Promise<void> {
  await page.getByRole('button', { name: 'Import collection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import collection' });
  await dialog.getByRole('button').filter({ hasText: 'OpenCollection' }).first().click();
  await dialog
    .locator('#file-upload-opencollection')
    .setInputFiles({ name: 'grpc-runner.yml', mimeType: 'application/yaml', buffer });
  await dialog.getByRole('button', { name: 'Confirm import' }).click();
  await expect(dialog).not.toBeVisible({ timeout: 8_000 });
  await expect(page.getByText(NAME, { exact: true }).first()).toBeVisible({ timeout: 8_000 });
}

async function openRunner(page: Page): Promise<void> {
  // Collections accumulate in the shared desktop window — target this one's row.
  const row = page
    .getByText(NAME, { exact: true })
    .first()
    .locator('xpath=ancestor::*[.//button[@aria-label="Collection options"]][1]');
  await row.hover();
  await row.getByRole('button', { name: 'Collection options' }).click();
  await page.getByRole('menuitem', { name: 'Run collection' }).click();
}

test.describe('Desktop gRPC collection run (#871)', () => {
  test('runs saved unary gRPC requests: proto snapshot + reflection fallback', async ({
    app: page,
    servers,
  }) => {
    await importCollection(page, buildCollection(servers.grpc.url));
    await openRunner(page);

    const dialog = page.getByRole('dialog', { name: /Run collection/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Run \d+ request/ }).click();

    await expect(dialog.getByText('2 passed')).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText('Echo via proto snapshot')).toBeVisible();
    await expect(dialog.getByText('Echo via reflection fallback')).toBeVisible();

    // The window is shared across specs: a left-open modal dialog makes the rest
    // of the app inert (aria-hidden), breaking whichever spec runs next.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
