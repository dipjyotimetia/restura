import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/app';
import { COMPLEX_PAYLOAD, CONFORMANCE_PROTO, canonicalPayload } from './mocks/conformanceFixtures';
import {
  type ConformanceServers,
  startConformanceServers,
  VALID_API_KEY,
  VALID_BASIC,
  VALID_BEARER,
} from './mocks/conformanceServer';
import { resetPersistedState } from './utils/reset-state';
import { fillFirstMonacoEditor, switchMode } from './utils/selectors';

/**
 * Browser gRPC conformance: the real web app + Worker against the
 * conformance server (connect-node, plus an Envoy-style gRPC-Web text front),
 * driven through the UI the way a user would — upload the `.proto`, pick the
 * auth method in the Auth tab, add metadata, choose the wire protocol — and
 * asserting on what the SERVER reports it received (principal, metadata,
 * protocol), not just on a green status.
 */
let servers: ConformanceServers;
test.beforeAll(async () => {
  servers = await startConformanceServers();
});
test.afterAll(async () => {
  await servers.close();
});

const SERVICE = 'conformance.v1.ConformanceService';

// Each test starts from clean persisted state (tabs, schemas, globals).
test.beforeEach(async ({ app: page }) => {
  await resetPersistedState(page);
});

function workspace(page: Page) {
  return page.getByRole('main', { name: 'Request workspace' });
}

async function setGlobal(page: Page, name: string, value: string): Promise<void> {
  await page.getByRole('button', { name: /Switch environment/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Environments' });
  const manage = page.getByRole('menuitem', { name: 'Manage environments…' });
  await expect(manage.or(dialog)).toBeVisible();
  if (await manage.isVisible()) await manage.click();
  await dialog
    .getByRole('button', { name: /Edit globals|Globals/ })
    .first()
    .click();
  await dialog.getByRole('button', { name: 'Add global' }).click();
  await dialog.getByRole('textbox', { name: 'Global name' }).last().fill(name);
  await dialog.getByRole('textbox', { name: `Value of ${name}` }).fill(value);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
}

type Auth =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'api-key'; key: string; value: string };

async function prepare(
  page: Page,
  call: {
    url: string;
    method: string;
    body: string;
    wire: string;
    auth?: Auth;
    metadata?: [string, string];
  }
) {
  await switchMode(page, 'grpc');
  // URL first: a new tab's default URL is the public echo server, whose
  // auto-discovery would otherwise select its own service. Then upload the
  // schema, which selects its service and first method.
  await page.getByRole('textbox', { name: 'gRPC server URL' }).fill(call.url);
  await page.getByLabel('Upload .proto file').setInputFiles({
    name: 'conformance.proto',
    mimeType: 'text/plain',
    buffer: Buffer.from(CONFORMANCE_PROTO),
  });
  // The upload fills service + first method (Unary). With no reflection from
  // this server they stay text fields; type the method under test.
  await expect(page.getByPlaceholder(/Service \(e\.g\./i)).toHaveValue(SERVICE);
  await page.getByPlaceholder(/Method \(e\.g\./i).fill(call.method);
  await fillFirstMonacoEditor(page, call.body);

  if (call.metadata) {
    await page.getByRole('tab', { name: /^Metadata/ }).click();
    await page.getByRole('button', { name: 'Add metadata' }).click();
    await page.getByLabel(/key$/i).last().fill(call.metadata[0]);
    await page
      .getByLabel(/value$/i)
      .last()
      .fill(call.metadata[1]);
  }

  if (call.auth) {
    await page.getByRole('tab', { name: 'Auth' }).click();
    const picker = page.getByRole('group', { name: 'gRPC authentication type' });
    if (call.auth.kind === 'bearer') {
      await picker.getByRole('button', { name: 'Bearer', exact: true }).click();
      await page.getByPlaceholder('Enter bearer token').fill(call.auth.token);
    } else if (call.auth.kind === 'basic') {
      await picker.getByRole('button', { name: 'Basic', exact: true }).click();
      await page.getByPlaceholder('Enter username').fill(call.auth.username);
      await page.getByPlaceholder('Enter password').fill(call.auth.password);
    } else {
      await picker.getByRole('button', { name: 'API Key', exact: true }).click();
      await page.getByPlaceholder('e.g., X-API-Key').fill(call.auth.key);
      await page.getByPlaceholder('Enter API key value').fill(call.auth.value);
    }
  }

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: call.wire, exact: true }).click();
}

async function invoke(page: Page) {
  const button = page.getByRole('button', { name: 'Invoke gRPC method' });
  await expect(button).toBeEnabled();
  await button.click();
}

/**
 * Read a value out of the response with the viewer's JSONPath query. The body
 * editor only renders visible lines, so the server's report is read through
 * the query panel (a fully-rendered <pre>), exactly as a user would.
 */
async function queryResponse(page: Page, path: string): Promise<unknown> {
  const toggle = page.getByRole('button', { name: 'Query with JSONPath' });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await page.getByLabel('JSONPath expression').fill(path);
  const out = workspace(page).locator('pre').filter({ hasText: /\S/ }).last();
  await expect(out).toBeVisible();
  return JSON.parse((await out.textContent()) ?? 'null');
}

async function expectOk(page: Page) {
  await expect(page.getByRole('button', { name: 'Query with JSONPath' })).toBeVisible();
  await expect(workspace(page)).toContainText('OK');
}

const WIRES = [
  // Connect JSON replies omit implicit (zero) fields; gRPC-Web replies are
  // decoded with the schema, which shows every field.
  { wire: 'Auto', url: () => servers.connectHttp1Url, protocol: 'connect', implicit: false },
  { wire: 'Connect', url: () => servers.connectHttp1Url, protocol: 'connect', implicit: false },
  { wire: 'gRPC-Web', url: () => servers.connectHttp1Url, protocol: 'grpc-web', implicit: true },
  {
    wire: 'gRPC-Web text',
    url: () => servers.grpcWebTextUrl,
    protocol: 'grpc-web',
    implicit: true,
  },
];

for (const { wire, url, protocol, implicit } of WIRES) {
  test.describe(`gRPC conformance (browser) · ${wire}`, () => {
    test('Bearer from a {{variable}} + custom metadata reach the server', async ({ app: page }) => {
      await setGlobal(page, 'confToken', VALID_BEARER);
      await prepare(page, {
        url: url(),
        method: 'Secure',
        body: '{"payload":{"fString":"ui-bearer"}}',
        wire,
        auth: { kind: 'bearer', token: '{{confToken}}' },
        metadata: ['x-tenant', 'acme-ui'],
      });
      await invoke(page);
      await expectOk(page);
      expect(await queryResponse(page, '$.call')).toMatchObject({
        authScheme: 'bearer',
        principal: 'token-user',
        metadata: { 'x-tenant': 'acme-ui' },
        protocol,
      });
    });

    test('Basic credentials', async ({ app: page }) => {
      await prepare(page, {
        url: url(),
        method: 'Secure',
        body: '{"payload":{}}',
        wire,
        auth: { kind: 'basic', ...VALID_BASIC },
      });
      await invoke(page);
      await expectOk(page);
      expect(await queryResponse(page, '$.call.principal')).toBe('alice');
    });

    test('API key header', async ({ app: page }) => {
      await prepare(page, {
        url: url(),
        method: 'Secure',
        body: '{"payload":{}}',
        wire,
        auth: { kind: 'api-key', key: VALID_API_KEY.header, value: VALID_API_KEY.value },
      });
      await invoke(page);
      await expectOk(page);
      expect(await queryResponse(page, '$.call.principal')).toBe('api-key-client');
    });

    test('no credentials → UNAUTHENTICATED with the server reason', async ({ app: page }) => {
      await prepare(page, { url: url(), method: 'Secure', body: '{"payload":{}}', wire });
      await invoke(page);
      await expect(workspace(page)).toContainText('UNAUTHENTICATED');
      await expect(workspace(page)).toContainText('MISSING_CREDENTIALS');
    });

    test('complex payload (Any, Struct, maps, int64, bytes…) round-trips exactly', async ({
      app: page,
    }) => {
      await prepare(page, {
        url: url(),
        method: 'Unary',
        body: JSON.stringify({ payload: COMPLEX_PAYLOAD }),
        wire,
      });
      await invoke(page);
      await expectOk(page);
      expect(await queryResponse(page, '$.payload')).toEqual(
        canonicalPayload(COMPLEX_PAYLOAD, implicit)
      );
    });
  });
}
