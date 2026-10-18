// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type MockMcpV2ServerHandle, startMockMcpV2Server } from '../e2e/mocks/mcpV2Server';
import { bindLocalhost, closeServer } from '../e2e/utils/serverHelpers';
import type * as IpcUtils from '../electron/main/ipc/ipc-utils';
import type { McpClientResponse } from '../electron/main/ipc/ipc-validators';

/**
 * End-to-end regression for MCP-4 (#860): Restura's desktop SDK client wired to
 * the real server→client request bridge, against live servers of both eras.
 * The renderer is simulated at the IPC seam: every `mcp:client-request:*` emit
 * is answered through `resolveMcpClientResponse`, exactly as the
 * `mcp:client-response` invoke handler would.
 */

const WEB_CONTENTS_ID = 42;
const CONNECTION_ID = 'conn-860';

type Answer = (event: {
  kind: 'elicitation' | 'sampling';
  params: unknown;
}) => McpClientResponse['response'] | undefined;

const renderer = vi.hoisted(() => ({
  answer: undefined as undefined | ((wcId: number, channel: string, payload: unknown) => void),
  prompts: [] as Array<{ kind: string; params: unknown }>,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: () => undefined },
}));
vi.mock('../electron/main/ipc/ipc-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcUtils>();
  return {
    ...actual,
    emitTo: (wcId: number, channel: string, payload: unknown) =>
      renderer.answer?.(wcId, channel, payload),
  };
});

import {
  McpClientRequestBridge,
  resolveMcpClientResponse,
  setMcpRoots,
  stopMcpClientRequests,
} from '../electron/main/handlers/mcp-client-requests';
import { connectMcpSdkClient, type McpSdkClient } from '../electron/main/handlers/mcp-sdk-client';

function simulateRenderer(answer: Answer): void {
  renderer.answer = (wcId, channel, payload) => {
    if (!channel.startsWith('mcp:client-request:')) return;
    const event = payload as {
      requestId: string;
      kind: 'elicitation' | 'sampling';
      params: unknown;
    };
    renderer.prompts.push({ kind: event.kind, params: event.params });
    const response = answer(event);
    if (!response) return;
    queueMicrotask(() => {
      const result = resolveMcpClientResponse(
        {
          kind: event.kind,
          connectionId: CONNECTION_ID,
          requestId: event.requestId,
          response,
        } as McpClientResponse,
        wcId
      );
      if (!result.success) throw new Error(`renderer answer rejected: ${result.error}`);
    });
  };
}

async function connect(url: string, withBridge = true) {
  const bridge = withBridge ? new McpClientRequestBridge(CONNECTION_ID, WEB_CONTENTS_ID) : null;
  const client = await connectMcpSdkClient({
    url: new URL(url),
    transport: 'streamable-http',
    transportOptions: { fetch: globalThis.fetch, requestInit: {} },
    ...(bridge ? { clientRequests: bridge } : {}),
    onClientCreated: (created) => bridge?.attachClient(created),
  });
  clients.push(client);
  return { client, bridge };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return content?.map((block) => block.text ?? '').join('') ?? '';
}

const clients: McpSdkClient[] = [];
let v2Server: MockMcpV2ServerHandle | undefined;
let legacyServer: { url: string; close: () => Promise<void> } | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  stopMcpClientRequests();
  renderer.answer = undefined;
  renderer.prompts.length = 0;
  await v2Server?.close();
  v2Server = undefined;
  await legacyServer?.close();
  legacyServer = undefined;
});

describe('2026-07-28 input_required (v2 mock)', () => {
  it('MCP-4: an input_required tool call succeeds after the client answers', async () => {
    v2Server = await startMockMcpV2Server();
    simulateRenderer(() => ({ action: 'accept', content: { confirm: true } }));
    const { client } = await connect(v2Server.url);
    expect(client.getProtocolVersion()).toBe('2026-07-28');

    const result = await client.request(
      'tools/call',
      { name: 'confirm-deploy', arguments: { environment: 'prod' } },
      10_000
    );
    expect(textOf(result)).toBe('deployed:prod');
    expect(renderer.prompts).toEqual([
      {
        kind: 'elicitation',
        params: expect.objectContaining({ message: 'Deploy to prod?' }),
      },
    ]);
  });

  it('without the bridge the same call fails (pre-fix behaviour)', async () => {
    v2Server = await startMockMcpV2Server();
    const { client } = await connect(v2Server.url, false);
    await expect(
      client.request(
        'tools/call',
        { name: 'confirm-deploy', arguments: { environment: 'prod' } },
        10_000
      )
    ).rejects.toThrow(/elicitation\/create/);
  });

  it.each(['decline', 'cancel'] as const)('returns the %s action to the server', async (action) => {
    v2Server = await startMockMcpV2Server();
    simulateRenderer(() => ({ action }));
    const { client } = await connect(v2Server.url);
    const result = await client.request(
      'tools/call',
      { name: 'confirm-deploy', arguments: { environment: 'test' } },
      10_000
    );
    expect(textOf(result)).toBe(`deploy:${action}`);
  });

  it('fulfils sampling only with the human-approved text', async () => {
    v2Server = await startMockMcpV2Server();
    simulateRenderer(({ kind }) =>
      kind === 'sampling' ? { action: 'approve', text: 'forty-two', model: 'manual' } : undefined
    );
    const { client } = await connect(v2Server.url);
    const result = await client.request(
      'tools/call',
      { name: 'ask-model', arguments: { question: 'meaning of life?' } },
      10_000
    );
    expect(textOf(result)).toBe('model:manual:forty-two');
    expect(renderer.prompts[0]?.params).toMatchObject({
      maxTokens: 64,
      messages: [{ role: 'user', content: { type: 'text', text: 'meaning of life?' } }],
    });
  });

  it('answers embedded roots/list from the per-connection roots', async () => {
    v2Server = await startMockMcpV2Server();
    await setMcpRoots(CONNECTION_ID, [{ uri: 'file:///work/a' }, { uri: 'file:///work/b' }], {
      id: WEB_CONTENTS_ID,
    });
    const { client } = await connect(v2Server.url);
    const result = await client.request(
      'tools/call',
      { name: 'list-roots', arguments: {} },
      10_000
    );
    expect(textOf(result)).toBe('file:///work/a,file:///work/b');
  });
});

async function startLegacyServer() {
  const rootsChanged: Array<() => void> = [];
  const mcp = new McpServer(
    { name: 'legacy-860', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  mcp.registerTool('confirm', { inputSchema: z.object({}) }, async (_args, ctx) => {
    const answer = await ctx.mcpReq.elicitInput({
      mode: 'form',
      message: 'Proceed?',
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean' } },
        required: ['confirm'],
      },
    });
    return {
      content: [
        { type: 'text', text: `${answer.action}:${JSON.stringify(answer.content ?? null)}` },
      ],
    };
  });
  mcp.registerTool('sample', { inputSchema: z.object({}) }, async (_args, ctx) => {
    try {
      const answer = await ctx.mcpReq.requestSampling({
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
        maxTokens: 8,
      });
      const content = answer.content;
      return {
        content: [
          {
            type: 'text',
            text: !Array.isArray(content) && content.type === 'text' ? content.text : '',
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `error:${(err as { code?: number }).code}` }],
        isError: true,
      };
    }
  });
  mcp.registerTool('roots', { inputSchema: z.object({}) }, async () => {
    const { roots } = await mcp.server.listRoots();
    return { content: [{ type: 'text', text: roots.map((root) => root.uri).join(',') }] };
  });
  mcp.server.setNotificationHandler('notifications/roots/list_changed', () => {
    for (const resolve of rootsChanged.splice(0)) resolve();
  });

  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await mcp.connect(transport);
  const server: Server = createServer((req, res) => {
    void transport.handleRequest(req, res);
  });
  const port = await bindLocalhost(server);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    nextRootsChanged: () => new Promise<void>((resolve) => rootsChanged.push(resolve)),
    close: async () => {
      await mcp.close().catch(() => undefined);
      await closeServer(server);
    },
  };
}

describe('2025-era push-style server→client requests', () => {
  it('round-trips elicitation, sampling and roots over a stateful session', async () => {
    const legacy = await startLegacyServer();
    legacyServer = legacy;
    simulateRenderer(({ kind }) =>
      kind === 'elicitation'
        ? { action: 'accept', content: { confirm: true } }
        : { action: 'approve', text: 'hello back', model: 'manual' }
    );
    await setMcpRoots(CONNECTION_ID, [{ uri: 'file:///repo', name: 'repo' }], {
      id: WEB_CONTENTS_ID,
    });
    const { client } = await connect(legacy.url);
    expect(client.getProtocolVersion()).not.toBe('2026-07-28');

    const confirm = await client.request('tools/call', { name: 'confirm', arguments: {} }, 10_000);
    expect(textOf(confirm)).toBe('accept:{"confirm":true}');

    const sample = await client.request('tools/call', { name: 'sample', arguments: {} }, 10_000);
    expect(textOf(sample)).toBe('hello back');

    const roots = await client.request('tools/call', { name: 'roots', arguments: {} }, 10_000);
    expect(textOf(roots)).toBe('file:///repo');

    // Editing roots sends notifications/roots/list_changed to the live session.
    const changed = legacy.nextRootsChanged();
    await expect(
      setMcpRoots(CONNECTION_ID, [{ uri: 'file:///other' }], { id: WEB_CONTENTS_ID })
    ).resolves.toEqual({ success: true, notified: 1 });
    await changed;
    const updated = await client.request('tools/call', { name: 'roots', arguments: {} }, 10_000);
    expect(textOf(updated)).toBe('file:///other');
  });

  it('surfaces a rejected sampling request to the server as the user-rejected error', async () => {
    const legacy = await startLegacyServer();
    legacyServer = legacy;
    simulateRenderer(() => ({ action: 'reject' }));
    const { client } = await connect(legacy.url);
    const sample = await client.request('tools/call', { name: 'sample', arguments: {} }, 10_000);
    expect(textOf(sample)).toBe('error:-1');
  });

  it('rejects a parked prompt when the connection closes mid-request', async () => {
    const legacy = await startLegacyServer();
    legacyServer = legacy;
    simulateRenderer(() => undefined); // the user never answers
    const { client, bridge } = await connect(legacy.url);
    const call = client.request('tools/call', { name: 'confirm', arguments: {} }, 10_000);
    await vi.waitFor(() => expect(renderer.prompts).toHaveLength(1));
    bridge?.dispose();
    await client.close();
    await expect(call).rejects.toBeDefined();
  });
});
