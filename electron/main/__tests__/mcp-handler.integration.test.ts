import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as IpcUtils from '../ipc/ipc-utils';

/**
 * Integration test: the SDK-backed MCP IPC handler against a REAL MCP server
 * (the SDK's own McpServer over StreamableHTTP, bound to 127.0.0.1). Only the
 * `electron` module and the IPC event-emit surface are mocked — DNS-guard,
 * pinned undici fetch, and the full SDK client/server wire all run for real.
 */

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
}));
vi.mock('../ipc/ipc-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcUtils>();
  return { ...actual, emitTo: mockEmitTo };
});

import { type MockMcpServerHandle, startMockMcpServer } from '../../../e2e/mocks/mcpServer';
import { registerMcpHandlerIPC, stopMcpCleanup } from '../handlers/mcp-handler';
import { setExecutionPolicy } from '../security/execution-policy';

type IpcHandler = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;

const trustedEvent = {
  sender: { id: 1, isDestroyed: () => false, once: vi.fn() },
  senderFrame: { url: 'file:///app/dist/web/index.html' },
};

function handlerFor(channel: string): IpcHandler {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as IpcHandler;
}

describe('mcp-handler integration (SDK client ↔ SDK server over real HTTP)', () => {
  let server: MockMcpServerHandle;

  beforeAll(async () => {
    setExecutionPolicy({
      security: { allowLocalhost: true, allowPrivateIPs: false },
      proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      timeout: 30_000,
      tls: { verifySsl: true, serverCipherOrder: false },
      certificates: { clientCertificates: [], caCertificates: [] },
    });
    server = await startMockMcpServer();
    registerMcpHandlerIPC();
  });

  afterAll(async () => {
    stopMcpCleanup();
    await server.close();
  });

  it('connects, discovers, calls a tool, and disconnects', async () => {
    const connectRes = await handlerFor('mcp:connect')(trustedEvent, {
      connectionId: 'integ-1',
      url: server.url,
      transport: 'streamable-http',
    });
    expect(connectRes).toEqual({ success: true });
    expect(mockEmitTo).toHaveBeenCalledWith(1, 'mcp:open:integ-1');
    // The SDK ran the real initialize handshake during connect.
    expect(server.initializeCount()).toBe(1);

    // The renderer's discovery flow re-sends `initialize`; the handler must
    // synthesize it from negotiated state, not re-send it on the wire.
    const initRes = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'integ-1',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r' } },
    });
    expect(initRes.success).toBe(true);
    const init = initRes.result as {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo?: { name?: string };
    };
    expect(init.protocolVersion).toBeTruthy();
    expect(init.capabilities).toHaveProperty('tools');
    expect(init.serverInfo?.name).toBe('restura-mock-mcp');
    expect(server.initializeCount()).toBe(1); // unchanged — not re-sent

    const listRes = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'integ-1',
      method: 'tools/list',
    });
    expect(listRes.success).toBe(true);
    const tools = (listRes.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['echo', 'add', 'fail']));

    const callRes = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'integ-1',
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hello' } },
    });
    expect(callRes.success).toBe(true);
    const content = (callRes.result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0]?.text).toBe('echo:hello');
    expect(server.toolCallCount()).toBe(1);

    // isError tool results are NOT JSON-RPC errors — they come back as results.
    const failRes = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'integ-1',
      method: 'tools/call',
      params: { name: 'fail', arguments: { reason: 'because' } },
    });
    expect(failRes.success).toBe(true);
    expect((failRes.result as { isError?: boolean }).isError).toBe(true);

    const disconnectRes = await handlerFor('mcp:disconnect')(trustedEvent, {
      connectionId: 'integ-1',
    });
    expect(disconnectRes).toEqual({ success: true });

    const afterRes = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'integ-1',
      method: 'tools/list',
    });
    expect(afterRes).toEqual({ success: false, error: 'Not connected' });
  });

  it('reads resources and prompts end-to-end', async () => {
    await handlerFor('mcp:connect')(trustedEvent, {
      connectionId: 'integ-2',
      url: server.url,
      transport: 'streamable-http',
    });

    const resourceRes = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'integ-2',
      method: 'resources/read',
      params: { uri: 'restura://readme' },
    });
    expect(resourceRes.success).toBe(true);
    const contents = (resourceRes.result as { contents: Array<{ text: string }> }).contents;
    expect(contents[0]?.text).toContain('restura mock');

    const promptRes = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'integ-2',
      method: 'prompts/get',
      params: { name: 'greet', arguments: { name: 'Ada' } },
    });
    expect(promptRes.success).toBe(true);
    const messages = (promptRes.result as { messages: Array<{ content: { text: string } }> })
      .messages;
    expect(messages[0]?.content.text).toContain('Ada');

    await handlerFor('mcp:disconnect')(trustedEvent, { connectionId: 'integ-2' });
  });

  it('surfaces unknown methods as jsonRpcError from the real server', async () => {
    await handlerFor('mcp:connect')(trustedEvent, {
      connectionId: 'integ-3',
      url: server.url,
      transport: 'streamable-http',
    });

    const res = await handlerFor('mcp:request')(trustedEvent, {
      connectionId: 'integ-3',
      method: 'definitely/not-a-method',
      timeout: 10_000,
    });
    expect(res.success).toBe(false);
    expect(res.jsonRpcError).toMatchObject({ code: -32601 });

    await handlerFor('mcp:disconnect')(trustedEvent, { connectionId: 'integ-3' });
  });

  it('rejects a connect to a non-listening port with a clean error', async () => {
    const res = await handlerFor('mcp:connect')(trustedEvent, {
      connectionId: 'integ-dead',
      url: 'http://127.0.0.1:1/mcp',
      transport: 'streamable-http',
    });
    expect(res.success).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});
