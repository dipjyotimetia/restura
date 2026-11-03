import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import type { Page } from '@playwright/test';
import { registryFromProtoText } from '../shared/protocol/grpc-registry';
import { expect, test } from './fixtures/servers';
import { EDGE_PROTO, EDGE_SERVICE } from './mocks/grpcServer';
import { EchoReplySchema, EchoRequestSchema } from './mocks/proto/gen/echo_pb';
import { setGrpcTarget } from './utils/grpc';
import { fillFirstMonacoEditor, switchMode } from './utils/selectors';

/**
 * End-to-end coverage for the gRPC protocol review fixes, against the real
 * Worker (Miniflare) and the real mock gRPC server:
 *  - Connect relay status mapping for non-Connect replies (404 / 415),
 *    deadline propagation, reserved-header filtering, path prefixes,
 *    non-PascalCase method names and the streamed body cap;
 *  - the gRPC-Web relay against a prefixed endpoint;
 *  - in the browser: `{{variable}}` URLs, protobuf identifiers the builder
 *    used to refuse, and google.protobuf.Any over gRPC-Web.
 *
 * Requires the Worker in dev mode (`.dev.vars` ENVIRONMENT=development).
 */
const WORKER = 'http://localhost:5173';
const ECHO = 'echo.v1.EchoService';

const edgeRegistry = registryFromProtoText(EDGE_PROTO, 'edge.proto');
const ECHO_PROTO = readFileSync(resolve(__dirname, 'mocks/proto/echo.proto'), 'utf8');
const INNER_ANY = { '@type': 'type.googleapis.com/edge.v1.Inner', x: 'packed' };

test.describe('Worker /api/grpc — Connect relay', () => {
  test('a non-Connect 404 maps to UNIMPLEMENTED with an HTTP reason', async ({
    request,
    servers,
  }) => {
    const res = await request.post(`${WORKER}/api/grpc`, {
      data: { url: servers.grpc.url, service: 'nope.v1.Missing', method: 'Gone', message: {} },
    });
    const json = (await res.json()) as { grpcStatus: number; data: { error: string } };
    expect(json.grpcStatus).toBe(Code.Unimplemented);
    expect(json.data.error).toMatch(/^HTTP 404/);
  });

  test('a native-gRPC-only server (HTTP 415) is reported explicitly', async ({
    request,
    servers,
  }) => {
    const res = await request.post(`${WORKER}/api/grpc`, {
      data: {
        url: servers.grpc.nativeOnlyUrl,
        service: ECHO,
        method: 'UnaryEcho',
        message: { message: 'x' },
      },
    });
    const json = (await res.json()) as { grpcStatus: number; data: { error: string } };
    expect(json.grpcStatus).toBe(Code.Unknown);
    expect(json.data.error).toMatch(/^HTTP 415: invalid gRPC request content-type/);
    expect(json.data.error).toContain('may not speak the Connect protocol');
  });

  test('propagates the deadline and keeps protocol headers authoritative', async ({
    request,
    servers,
  }) => {
    const res = await request.post(`${WORKER}/api/grpc`, {
      data: {
        url: servers.grpc.url,
        service: ECHO,
        method: 'UnaryEcho',
        message: { message: 'deadline' },
        timeout: 7_000,
        metadata: {
          'content-type': 'application/grpc',
          'connect-timeout-ms': '1',
          'x-echo-k': 'v',
        },
      },
    });
    const json = (await res.json()) as { grpcStatus: number; headers: Record<string, string> };
    expect(json.grpcStatus).toBe(0);
    const seen = servers.grpc.lastRequestHeaders();
    expect(seen['connect-timeout-ms']).toBe('7000');
    expect(seen['content-type']).toBe('application/json');
    expect(json.headers['x-echo-k']).toBe('v');
  });

  test('keeps the URL path prefix', async ({ request, servers }) => {
    const res = await request.post(`${WORKER}/api/grpc`, {
      data: {
        url: `${servers.grpc.prefixedUrl}/`,
        service: ECHO,
        method: 'UnaryEcho',
        message: { message: 'prefixed' },
      },
    });
    const json = (await res.json()) as { grpcStatus: number; data: { message: string } };
    expect(json.grpcStatus).toBe(0);
    expect(json.data.message).toBe('echo: prefixed');
  });

  test('calls a non-PascalCase method (legal protobuf)', async ({ request, servers }) => {
    const res = await request.post(`${WORKER}/api/grpc`, {
      data: {
        url: servers.grpc.url,
        service: EDGE_SERVICE,
        method: 'get_item',
        message: { note: 'n1' },
      },
    });
    const json = (await res.json()) as { grpcStatus: number; data: { note: string } };
    expect(json.grpcStatus).toBe(0);
    expect(json.data.note).toBe('got n1');
  });

  test('caps a streamed (chunked) request body with 413', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 13 MiB — past the 12 MiB /api/grpc cap, never infinite.
        if (sent++ >= 13) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await fetch(`${WORKER}/api/grpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
  });
});

test.describe('Worker /api/grpc-web — gRPC-Web relay', () => {
  test('relays a binary gRPC-Web unary call to a path-prefixed endpoint', async ({
    request,
    servers,
  }) => {
    const payload = toBinary(EchoRequestSchema, create(EchoRequestSchema, { message: 'gw' }));
    const res = await request.post(`${WORKER}/api/grpc-web`, {
      data: {
        url: servers.grpc.prefixedUrl,
        service: ECHO,
        method: 'UnaryEcho',
        message: Buffer.from(payload).toString('base64'),
      },
    });
    expect(res.ok()).toBe(true);
    const events = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; data?: string; grpcStatus?: number });
    const msg = events.find((e) => e.type === 'message');
    expect(events.at(-1)).toMatchObject({ type: 'end', grpcStatus: 0 });
    const reply = fromBinary(EchoReplySchema, Buffer.from(msg?.data ?? '', 'base64'));
    expect(reply.message).toBe('echo: gw');
  });
});

// --- Browser (renderer + Worker + mock server) -------------------------------

async function setGlobal(page: Page, name: string, value: string): Promise<void> {
  await page.getByRole('button', { name: /Switch environment/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Environments' });
  const manage = page.getByRole('menuitem', { name: 'Manage environments…' });
  await expect(manage.or(dialog)).toBeVisible();
  if (await manage.isVisible()) await manage.click();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: /Edit globals|Globals/ })
    .first()
    .click();
  await dialog.getByRole('button', { name: 'Add global' }).click();
  await dialog.getByRole('textbox', { name: 'Global name' }).last().fill(name);
  await dialog.getByRole('textbox', { name: `Value of ${name}` }).fill(value);
  // Globals commit on change; the globals view has only the header ✕.
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
}

/**
 * Fill a unary call in the builder. The builder needs a schema before it
 * invokes (the mock's reflection only lists services), so the matching
 * `.proto` is uploaded (via setGrpcTarget, which orders URL → schema →
 * service / method deterministically).
 */
async function fillCall(
  page: Page,
  call: { url: string; service: string; method: string; body: string; proto: 'echo' | 'edge' }
) {
  await switchMode(page, 'grpc');
  await setGrpcTarget(page, {
    url: call.url,
    service: call.service,
    method: call.method,
    proto: {
      name: `${call.proto}.proto`,
      text: call.proto === 'echo' ? ECHO_PROTO : EDGE_PROTO,
    },
  });
  await fillFirstMonacoEditor(page, call.body);
}

function invokeButton(page: Page) {
  return page.getByRole('button', { name: 'Invoke gRPC method' });
}

/**
 * The workspace text. Assertions use strings only the response can contain
 * (the server's reply / error), never text the request editor also holds.
 */
function workspace(page: Page) {
  return page.getByRole('main', { name: 'Request workspace' });
}

test.describe('gRPC builder (browser)', () => {
  test('sends to a {{variable}} URL resolved from globals', async ({ app: page, servers }) => {
    await setGlobal(page, 'grpcBase', servers.grpc.url);
    await fillCall(page, {
      url: '{{grpcBase}}',
      service: ECHO,
      method: 'UnaryEcho',
      body: '{"message":"via-vars"}',
      proto: 'echo',
    });
    await expect(invokeButton(page)).toBeEnabled();
    await invokeButton(page).click();
    await expect(workspace(page)).toContainText('echo: via-vars');
  });

  test('accepts protobuf names the builder used to refuse', async ({ app: page, servers }) => {
    await fillCall(page, {
      url: servers.grpc.url,
      service: EDGE_SERVICE,
      method: 'get_item',
      body: '{"note":"ui"}',
      proto: 'edge',
    });
    await expect(invokeButton(page)).toBeEnabled();
    await invokeButton(page).click();
    await expect(workspace(page)).toContainText('got ui');
  });

  test('shows the reason when the server is native-gRPC-only', async ({ app: page, servers }) => {
    await fillCall(page, {
      url: servers.grpc.nativeOnlyUrl,
      service: ECHO,
      method: 'UnaryEcho',
      body: '{"message":"x"}',
      proto: 'echo',
    });
    await invokeButton(page).click();
    await expect(workspace(page)).toContainText('HTTP 415');
    await expect(workspace(page)).toContainText('may not speak the Connect protocol');
  });

  test('round-trips google.protobuf.Any over gRPC-Web with an uploaded .proto', async ({
    app: page,
    servers,
  }) => {
    await fillCall(page, {
      url: servers.grpc.url,
      service: EDGE_SERVICE,
      method: 'Wrap',
      body: JSON.stringify({ note: 'any-reply', payload: INNER_ANY }),
      proto: 'edge',
    });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'gRPC-Web', exact: true }).click();
    await invokeButton(page).click();
    // The request editor holds `packed` too, so assert on the reply's
    // pretty-printed shape: the response viewer formats JSON with spaces.
    await expect(workspace(page)).toContainText('"note": "any-reply"');
    await expect(workspace(page)).toContainText('"@type": "type.googleapis.com/edge.v1.Inner"');
  });
});

// Keeps the registry import honest: the e2e Any fixture must stay encodable.
test('edge.proto Any fixture is a valid message', () => {
  const env = edgeRegistry.getMessage('edge.v1.Envelope');
  expect(env?.fields.map((f) => f.name)).toEqual(['note', 'payload']);
});
