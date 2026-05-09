import { test, expect } from './fixtures/servers';
import { switchMode } from './utils/selectors';
import { createConnectTransport, createGrpcTransport } from '@connectrpc/connect-node';
import { createClient } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { EchoService, EchoRequestSchema } from './mocks/proto/gen/echo_pb';

/**
 * Real gRPC server (Connect-RPC SDK + buf-generated descriptors).
 *
 * Coverage:
 *   - Unary               – via Worker /api/grpc proxy
 *   - Server-streaming    – wire test through Connect-Node client
 *   - Client-streaming    – wire test through gRPC HTTP/2 transport
 *   - Bidirectional       – wire test through gRPC HTTP/2 transport
 *
 * The web UI exposes unary through the Worker proxy and surfaces a
 * "Web Stream" panel for server-streaming. Client/bidi require HTTP/2 and
 * are reachable from Node test code via Connect-Node's gRPC transport.
 *
 * Requires the Worker in dev mode (`.dev.vars` ENVIRONMENT=development).
 */
test.describe('Real gRPC server (Connect-RPC SDK)', () => {
  test('UI exposes gRPC mode controls and accepts inputs', async ({ app: page, servers }) => {
    await switchMode(page, 'grpc');

    await page.getByRole('textbox', { name: 'gRPC server URL' }).fill(servers.grpc.url);
    await page.getByPlaceholder(/Service \(e\.g\./i).fill('echo.v1.EchoService');
    await page.getByPlaceholder(/Method \(e\.g\./i).fill('UnaryEcho');

    await expect(page.getByRole('textbox', { name: 'gRPC server URL' })).toHaveValue(servers.grpc.url);
  });

  test('Worker /api/grpc proxies a unary call to the mock server', async ({ request, servers }) => {
    const res = await request.post('http://localhost:5173/api/grpc', {
      data: {
        url: servers.grpc.url,
        service: 'echo.v1.EchoService',
        method: 'UnaryEcho',
        message: { message: 'ping' },
        timeout: 10_000,
      },
    });

    expect(res.ok(), `Worker rejected gRPC unary: ${res.status()} ${await res.text()}`).toBe(true);
    const json = await res.json();
    expect(json.grpcStatus).toBe(0);
    expect(JSON.stringify(json.data)).toContain('echo: ping');
    expect(servers.grpc.unaryCount()).toBeGreaterThanOrEqual(1);
  });

  test('Worker /api/grpc/reflection lists services from the mock server', async ({ request, servers }) => {
    const res = await request.post('http://localhost:5173/api/grpc/reflection', {
      data: {
        url: servers.grpc.url,
        request: { listServices: '*' },
        timeout: 10_000,
      },
    });

    expect(res.ok(), `Reflection failed: ${res.status()} ${await res.text()}`).toBe(true);
    const dump = JSON.stringify(await res.json());
    expect(dump).toContain('echo.v1.EchoService');
    expect(servers.grpc.reflectionCount()).toBeGreaterThanOrEqual(1);
  });

  test('Connect-Node client: unary round-trip via Connect protocol', async ({ servers }) => {
    const transport = createConnectTransport({
      baseUrl: servers.grpc.url,
      httpVersion: '1.1',
    });
    const client = createClient(EchoService, transport);
    const reply = await client.unaryEcho(create(EchoRequestSchema, { message: 'hello', count: 0 }));
    expect(reply.message).toBe('echo: hello');
    expect(servers.grpc.unaryCount()).toBeGreaterThanOrEqual(1);
  });

  test('Connect-Node client: server-streaming yields N replies', async ({ servers }) => {
    const transport = createConnectTransport({
      baseUrl: servers.grpc.url,
      httpVersion: '1.1',
    });
    const client = createClient(EchoService, transport);

    const replies: Array<{ message: string; index: number }> = [];
    for await (const r of client.serverStreamingEcho(
      create(EchoRequestSchema, { message: 'tick', count: 4 })
    )) {
      replies.push({ message: r.message, index: r.index });
    }
    expect(replies.length).toBe(4);
    expect(replies[0]).toEqual({ message: 'echo[0]: tick', index: 0 });
    expect(replies[3]).toEqual({ message: 'echo[3]: tick', index: 3 });
    expect(servers.grpc.serverStreamCount()).toBeGreaterThanOrEqual(1);
  });

  test('Connect-Node client: client-streaming aggregates inbound messages', async ({ servers }) => {
    // Client-streaming requires HTTP/2 — use the gRPC transport over h2c.
    const transport = createGrpcTransport({
      baseUrl: servers.grpc.h2cUrl,
    });
    const client = createClient(EchoService, transport);

    async function* inputs() {
      yield create(EchoRequestSchema, { message: 'a', count: 0 });
      yield create(EchoRequestSchema, { message: 'b', count: 0 });
      yield create(EchoRequestSchema, { message: 'c', count: 0 });
    }

    const summary = await client.clientStreamingEcho(inputs());
    expect(summary.messageCount).toBe(3);
    expect(summary.concatenated).toBe('a|b|c');
    expect(servers.grpc.clientStreamCount()).toBeGreaterThanOrEqual(1);
  });

  test('Connect-Node client: bidirectional streaming echoes each input', async ({ servers }) => {
    const transport = createGrpcTransport({
      baseUrl: servers.grpc.h2cUrl,
    });
    const client = createClient(EchoService, transport);

    async function* inputs() {
      yield create(EchoRequestSchema, { message: 'one', count: 0 });
      yield create(EchoRequestSchema, { message: 'two', count: 0 });
      yield create(EchoRequestSchema, { message: 'three', count: 0 });
    }

    const replies: Array<{ message: string; index: number }> = [];
    for await (const r of client.bidirectionalEcho(inputs())) {
      replies.push({ message: r.message, index: r.index });
    }
    expect(replies).toEqual([
      { message: 'echo: one', index: 0 },
      { message: 'echo: two', index: 1 },
      { message: 'echo: three', index: 2 },
    ]);
    expect(servers.grpc.bidiCount()).toBeGreaterThanOrEqual(1);
  });

  test('UI surfaces a "Web Stream" panel for streaming method types', async ({ app: page, servers }) => {
    await switchMode(page, 'grpc');
    await page.locator('[role="combobox"]').filter({ hasText: /^Unary$/ }).first().click();
    await page.locator('[role="option"]').filter({ hasText: /Server Streaming/i }).click();

    await expect(page.getByRole('tab', { name: /Web Stream/i })).toBeVisible();

    await page.getByRole('textbox', { name: 'gRPC server URL' }).fill(servers.grpc.url);
    await page.getByPlaceholder(/Service \(e\.g\./i).fill('echo.v1.EchoService');
    await page.getByPlaceholder(/Method \(e\.g\./i).fill('ServerStreamingEcho');

    await page.getByRole('tab', { name: /Web Stream/i }).click();
    await expect(page.getByRole('button', { name: /Start stream/i })).toBeVisible();
  });
});
