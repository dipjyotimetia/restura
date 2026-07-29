import type { Page } from '@playwright/test';
import { fillFirstMonacoEditor, switchMode } from '../../e2e/utils/selectors';
import type { EnterpriseProxyStack } from '../../echo-local/enterprise-proxy';
import {
  ENTERPRISE_POLICY_AVAILABLE,
  ENTERPRISE_POLICY_PATH,
  expect,
  test,
} from '../fixtures/enterpriseProxy';

test.skip(
  !ENTERPRISE_POLICY_AVAILABLE,
  `Run npm run test:e2e:electron:enterprise:prepare to install ${ENTERPRISE_POLICY_PATH}`
);

function proxyTraffic(stack: EnterpriseProxyStack): number {
  return stack.proxy.connectCount() + stack.proxy.forwardCount();
}

async function setGrpcRequestMessage(page: Page, json: string): Promise<void> {
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
        (props.onChange as (next: string) => void)(value);
        return true;
      }
      fiber = (fiber as { return?: unknown }).return;
    }
    return false;
  }, json);
  if (!changed) throw new Error('Could not reach the gRPC Monaco onChange handler');
}

test.describe('Managed enterprise PAC routing', () => {
  test('HTTP uses ordered proxy fallback and origin-bound Basic auth', async ({
    app: page,
    enterpriseEcho,
  }) => {
    const before = proxyTraffic(enterpriseEcho.proxy);
    const response = await page.evaluate(async (url) => {
      return window.electron!.http.request({
        requestId: crypto.randomUUID(),
        method: 'GET',
        url: `${url}/json`,
      });
    }, enterpriseEcho.urls.http);

    expect(response.status).toBe(200);
    expect(enterpriseEcho.proxy.pacRequestCount()).toBeGreaterThanOrEqual(1);
    expect(proxyTraffic(enterpriseEcho.proxy)).toBeGreaterThan(before);
  });

  test('SOCKS5 PAC directive resolves the destination through the proxy', async ({
    app: page,
    enterpriseEcho,
  }) => {
    const before = enterpriseEcho.proxy.socks.connectCount();
    const response = await page.evaluate(async (url) => {
      return window.electron!.http.request({
        requestId: crypto.randomUUID(),
        method: 'GET',
        url: `${url}/json`,
      });
    }, enterpriseEcho.urls.socksHttp);

    expect(response.status).toBe(200);
    expect(enterpriseEcho.proxy.socks.connectCount()).toBeGreaterThan(before);
  });

  test('GraphQL rides the managed HTTP proxy', async ({ app: page, enterpriseEcho }) => {
    const before = proxyTraffic(enterpriseEcho.proxy);
    await switchMode(page, 'graphql');
    await page
      .getByRole('textbox', { name: 'GraphQL endpoint URL' })
      .fill(enterpriseEcho.urls.graphql);
    await fillFirstMonacoEditor(page, '{ hello(name: "Enterprise") }');
    await page.getByRole('button', { name: /Send GraphQL query/i }).click();

    await expect(page.getByText(/Hello,\s*Enterprise!?/).first()).toBeVisible();
    expect(proxyTraffic(enterpriseEcho.proxy)).toBeGreaterThan(before);
  });

  test('SSE streams through the managed proxy', async ({ app: page, enterpriseEcho }) => {
    const before = proxyTraffic(enterpriseEcho.proxy);
    await switchMode(page, 'sse');
    await page.getByPlaceholder('https://echo.restura.dev/sse').fill(enterpriseEcho.urls.sse);
    await page.getByRole('button', { name: 'Start SSE stream' }).click();

    await expect
      .poll(() => proxyTraffic(enterpriseEcho.proxy), { timeout: 15_000 })
      .toBeGreaterThan(before);
    const messageBadges = page
      .locator('div')
      .filter({ has: page.getByText('message', { exact: true }) });
    await expect
      .poll(async () => await messageBadges.count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(3);
    await page
      .getByRole('button', { name: 'Stop SSE stream' })
      .first()
      .click()
      .catch(() => {});
  });

  test('MCP initializes and discovers tools through the managed proxy', async ({
    app: page,
    enterpriseEcho,
  }) => {
    const before = proxyTraffic(enterpriseEcho.proxy);
    await switchMode(page, 'mcp');
    await page.getByPlaceholder('https://mcp.example.com/v1/server').fill(enterpriseEcho.urls.mcp);
    await page.getByRole('button', { name: /Connect/i }).click();
    const tools = page.getByRole('button', { name: 'Tools', exact: true });
    if ((await tools.getAttribute('aria-pressed')) !== 'true') await tools.click();

    await expect(page.getByRole('tab', { name: /Tools\s+3/ })).toBeVisible({ timeout: 15_000 });
    expect(proxyTraffic(enterpriseEcho.proxy)).toBeGreaterThan(before);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).first().click();
  });

  test('secure WebSocket connects and echoes through CONNECT', async ({
    app: page,
    enterpriseEcho,
  }) => {
    const before = enterpriseEcho.proxy.proxy.connectCount();
    await switchMode(page, 'ws');
    await page.getByRole('textbox', { name: 'WebSocket URL' }).fill(enterpriseEcho.urls.wss);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('radio', { name: 'text' }).click();
    const input = page.getByPlaceholder(/Enter message to send/i);
    await expect(input).toBeEnabled({ timeout: 15_000 });
    await input.fill('enterprise-wss');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText(/echo:enterprise-wss/).first()).toBeVisible();
    expect(enterpriseEcho.proxy.proxy.connectCount()).toBeGreaterThan(before);
    await page
      .getByRole('button', { name: /Disconnect/i })
      .first()
      .click();
  });

  test('Socket.IO connects and emits through the managed proxy', async ({
    app: page,
    enterpriseEcho,
  }) => {
    const before = proxyTraffic(enterpriseEcho.proxy);
    await switchMode(page, 'socketio');
    await page
      .getByRole('textbox', { name: 'Socket.IO server URL' })
      .fill(enterpriseEcho.urls.socketio);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByTestId('socketio-status')).toHaveText(/connected/i, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: /^Emit$/ }).click();
    await expect(page.getByText('message:echo').first()).toBeVisible({ timeout: 10_000 });

    expect(proxyTraffic(enterpriseEcho.proxy)).toBeGreaterThan(before);
    await page
      .getByRole('button', { name: /Disconnect/i })
      .first()
      .click();
  });

  test('gRPC reflection and unary calls traverse managed CONNECT', async ({
    app: page,
    enterpriseEcho,
  }) => {
    const before = enterpriseEcho.proxy.proxy.connectCount();
    await switchMode(page, 'grpc');
    await page.getByRole('textbox', { name: 'gRPC server URL' }).fill(enterpriseEcho.urls.grpc);
    await page.getByRole('button', { name: 'Discover', exact: true }).click();

    await expect(page.getByText('echo.v1.EchoService').first()).toBeVisible({ timeout: 15_000 });
    await setGrpcRequestMessage(page, '{"message":"enterprise-grpc","count":1}');
    await page.getByRole('button', { name: /Invoke gRPC method/i }).click();
    await expect(page.getByText(/echo:\s*enterprise-grpc/).first()).toBeVisible({
      timeout: 15_000,
    });
    expect(enterpriseEcho.proxy.proxy.connectCount()).toBeGreaterThan(before);
  });

  test('AI provider streaming traverses the managed proxy', async ({
    app: page,
    enterpriseEcho,
  }) => {
    const before = proxyTraffic(enterpriseEcho.proxy);
    await page.getByRole('button', { name: 'Open settings' }).click();
    const drawer = page.getByRole('dialog', { name: 'Settings' });
    await drawer.getByRole('button', { name: 'AI', exact: true }).click();
    await drawer.getByRole('combobox').first().click();
    await page.getByRole('option', { name: /OpenAI-compatible/i }).click();
    await drawer.getByPlaceholder('http://localhost:11434').fill(enterpriseEcho.urls.ai);
    await drawer.getByPlaceholder(/local model id/).fill('enterprise-mock-model');
    await drawer.getByRole('button', { name: 'Save local provider' }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();

    await page.getByRole('button', { name: 'Toggle AI chat' }).click();
    const composer = page.getByPlaceholder(/Ask about/i);
    await composer.fill('enterprise hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('echo: enterprise hello').first()).toBeVisible({
      timeout: 20_000,
    });
    expect(proxyTraffic(enterpriseEcho.proxy)).toBeGreaterThan(before);
    await page.getByRole('button', { name: 'Toggle AI chat' }).click();
  });

  test('raw MQTT and Kafka remain blocked without direct-protocol exceptions', async ({
    app: page,
  }) => {
    const results = await page.evaluate(async () => {
      const mqtt = await window.electron!.mqtt.connect({
        connectionId: crypto.randomUUID(),
        brokerUrl: 'mqtt://localhost:1883',
        protocolVersion: 5,
        clientId: 'enterprise-e2e',
        keepalive: 60,
        cleanStart: true,
        connectTimeout: 5_000,
        autoReconnect: false,
      });
      const kafka = await window.electron!.kafka.connect({
        connectionId: crypto.randomUUID(),
        clientId: 'enterprise-e2e',
        bootstrapBrokers: ['localhost:9092'],
        auth: { securityProtocol: 'PLAINTEXT' },
      });
      return { mqtt, kafka };
    });

    expect(results.mqtt).toMatchObject({ success: false });
    expect(results.kafka).toMatchObject({ success: false });
    expect(JSON.stringify(results).toLowerCase()).toContain('managed enterprise policy');
  });
});
