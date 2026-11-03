import type { Locator, Page } from '@playwright/test';
import {
  COMPLEX_PAYLOAD,
  CONFORMANCE_PROTO,
  canonicalPayload,
} from '../../e2e/mocks/conformanceFixtures';
import {
  type ConformanceServers,
  startConformanceServers,
  VALID_API_KEY,
  VALID_BASIC,
  VALID_BEARER,
} from '../../e2e/mocks/conformanceServer';
import { switchMode } from '../../e2e/utils/selectors';
import { expect, test } from '../fixtures/servers';

/**
 * Desktop gRPC conformance through the real app: renderer → IPC → main
 * (auth applied main-side) → connect-node transports, against connect-node
 * (native gRPC / Connect / gRPC-Web) and the grpc-js reference server, driven
 * through the UI (Auth picker, metadata, wire protocol) and judged by what the
 * SERVER reports it received.
 */
let servers: ConformanceServers;
test.beforeAll(async () => {
  servers = await startConformanceServers();
});
test.afterAll(async () => {
  await servers.close();
});

const visible = (l: Locator): Locator => l.filter({ visible: true });

async function setRequestMessage(page: Page, json: string): Promise<void> {
  // Drive the visible Monaco's React onChange (same approach as grpc.spec.ts).
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
  // URL first (a new tab's default URL would auto-discover another service).
  await visible(page.getByRole('textbox', { name: 'gRPC server URL' })).fill(call.url);
  await visible(page.getByRole('button', { name: /^Upload \.proto/ }))
    .first()
    .click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /^Files…/ }).click();
  await (await chooser).setFiles({
    name: 'conformance.proto',
    mimeType: 'text/plain',
    buffer: Buffer.from(CONFORMANCE_PROTO),
  });
  await expect(
    visible(page.getByRole('button', { name: 'conformance.proto' })).first()
  ).toBeVisible();
  // Desktop reflection can describe the service, turning the fields into
  // pickers; otherwise they stay text fields filled by the upload.
  const methodPicker = visible(page.getByRole('combobox').filter({ hasText: /^Unary$/ }));
  if (call.method !== 'Unary') {
    if (await methodPicker.count()) {
      await methodPicker.first().click();
      await page.getByRole('option', { name: call.method, exact: true }).click();
    } else {
      await visible(page.getByPlaceholder(/Method \(e\.g\./i)).fill(call.method);
    }
  }
  await setRequestMessage(page, call.body);

  if (call.metadata) {
    await visible(page.getByRole('tab', { name: /^Metadata/ })).click();
    await visible(page.getByRole('button', { name: 'Add metadata' })).click();
    await visible(page.getByLabel(/key$/i)).last().fill(call.metadata[0]);
    await visible(page.getByLabel(/value$/i))
      .last()
      .fill(call.metadata[1]);
  }
  if (call.auth) {
    await visible(page.getByRole('tab', { name: 'Auth' })).click();
    const picker = visible(page.getByRole('group', { name: 'gRPC authentication type' }));
    if (call.auth.kind === 'bearer') {
      await picker.getByRole('button', { name: 'Bearer', exact: true }).click();
      await visible(page.getByPlaceholder('Enter bearer token')).fill(call.auth.token);
    } else if (call.auth.kind === 'basic') {
      await picker.getByRole('button', { name: 'Basic', exact: true }).click();
      await visible(page.getByPlaceholder('Enter username')).fill(call.auth.username);
      await visible(page.getByPlaceholder('Enter password')).fill(call.auth.password);
    } else {
      await picker.getByRole('button', { name: 'API Key', exact: true }).click();
      await visible(page.getByPlaceholder('e.g., X-API-Key')).fill(call.auth.key);
      await visible(page.getByPlaceholder('Enter API key value')).fill(call.auth.value);
    }
  }
  await visible(page.getByRole('tab', { name: 'Settings' })).click();
  await visible(page.getByRole('radio', { name: call.wire, exact: true })).click();
  // Back to the message tab so the response panel is the focus of the run.
  await visible(page.getByRole('tab', { name: 'Message' })).click();
}

async function invoke(page: Page) {
  const button = visible(page.getByRole('button', { name: 'Invoke gRPC method' }));
  await expect(button).toBeEnabled();
  await button.click();
}

async function queryResponse(page: Page, path: string): Promise<unknown> {
  const toggle = visible(page.getByRole('button', { name: 'Query with JSONPath' })).first();
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await visible(page.getByLabel('JSONPath expression')).fill(path);
  const out = visible(page.locator('pre').filter({ hasText: /\S/ })).last();
  await expect(out).toBeVisible();
  return JSON.parse((await out.textContent()) ?? 'null');
}

const TARGETS = [
  {
    label: 'connect-node · Auto',
    wire: 'Auto',
    url: () => servers.connectH2cUrl,
    protocol: 'grpc',
  },
  {
    label: 'connect-node · gRPC',
    wire: 'gRPC',
    url: () => servers.connectH2cUrl,
    protocol: 'grpc',
  },
  {
    label: 'connect-node · Connect',
    wire: 'Connect',
    url: () => servers.connectH2cUrl,
    protocol: 'connect',
  },
  {
    label: 'connect-node · gRPC-Web',
    wire: 'gRPC-Web',
    url: () => servers.connectHttp1Url,
    protocol: 'grpc-web',
  },
  { label: 'grpc-js · Auto', wire: 'Auto', url: () => servers.grpcJsUrl, protocol: 'grpc-js' },
  { label: 'grpc-js · gRPC', wire: 'gRPC', url: () => servers.grpcJsUrl, protocol: 'grpc-js' },
];

for (const t of TARGETS) {
  test.describe(`Desktop gRPC conformance · ${t.label}`, () => {
    test('Bearer + custom metadata reach the server', async ({ app: page }) => {
      await prepare(page, {
        url: t.url(),
        method: 'Secure',
        body: '{"payload":{"fString":"desk"}}',
        wire: t.wire,
        auth: { kind: 'bearer', token: VALID_BEARER },
        metadata: ['x-tenant', 'acme-desk'],
      });
      await invoke(page);
      expect(await queryResponse(page, '$.call')).toMatchObject({
        authScheme: 'bearer',
        principal: 'token-user',
        metadata: { 'x-tenant': 'acme-desk' },
        protocol: t.protocol,
      });
    });

    test('Basic and API-key credentials', async ({ app: page }) => {
      await prepare(page, {
        url: t.url(),
        method: 'Secure',
        body: '{"payload":{}}',
        wire: t.wire,
        auth: { kind: 'basic', ...VALID_BASIC },
      });
      await invoke(page);
      expect(await queryResponse(page, '$.call.principal')).toBe('alice');

      await prepare(page, {
        url: t.url(),
        method: 'Secure',
        body: '{"payload":{}}',
        wire: t.wire,
        auth: { kind: 'api-key', key: VALID_API_KEY.header, value: VALID_API_KEY.value },
      });
      await invoke(page);
      expect(await queryResponse(page, '$.call.principal')).toBe('api-key-client');
    });

    test('complex payload round-trips exactly', async ({ app: page }) => {
      await prepare(page, {
        url: t.url(),
        method: 'Unary',
        body: JSON.stringify({ payload: COMPLEX_PAYLOAD }),
        wire: t.wire,
      });
      await invoke(page);
      expect(await queryResponse(page, '$.payload')).toEqual(canonicalPayload(COMPLEX_PAYLOAD));
    });
  });
}

test('Desktop: no credentials → UNAUTHENTICATED with the server reason', async ({ app: page }) => {
  await prepare(page, {
    url: servers.grpcJsUrl,
    method: 'Secure',
    body: '{"payload":{}}',
    wire: 'gRPC',
  });
  await invoke(page);
  await expect(page.getByText('MISSING_CREDENTIALS').first()).toBeVisible({ timeout: 15_000 });
});
