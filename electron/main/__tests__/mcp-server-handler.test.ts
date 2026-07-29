import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONSENT } from '@shared/mcp-server/consent';
import type { McpDispatchContext } from '@shared/mcp-server/dispatch';

const stdioState = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  factory: undefined as (() => unknown) | undefined,
  options: undefined as { legacy?: string } | undefined,
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: vi.fn((factory: () => unknown, options: { legacy?: string }) => {
    stdioState.factory = factory;
    stdioState.options = options;
    return { close: stdioState.close };
  }),
}));

import { createResturaMcpServer, startStdioMcpServer } from '../handlers/mcp-server-handler';

const connected: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(connected.splice(0).map((value) => value.close()));
  stdioState.close.mockClear();
  stdioState.factory = undefined;
  stdioState.options = undefined;
});

describe('createResturaMcpServer', () => {
  it('builds a fresh v2 server exposing the consent-gated Restura tool catalogue', async () => {
    const context: McpDispatchContext = {
      collections: [],
      environments: [],
      history: [],
      consent: DEFAULT_CONSENT,
    };
    const server = createResturaMcpServer(() => context);
    const client = new Client(
      { name: 'restura-server-test', version: '1.0.0' },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    connected.push(client, server);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const catalogue = await client.listTools();
    expect(catalogue.tools.map((tool) => tool.name).sort()).toEqual([
      'get_environment',
      'get_history',
      'list_collections',
      'list_environments',
      'list_requests',
    ]);
    await expect(client.callTool({ name: 'list_collections', arguments: {} })).resolves.toEqual({
      content: [{ type: 'text', text: '{\n  "collections": []\n}' }],
    });
  });

  it('serves stdio through the v2 compatibility transport with isolated server instances', async () => {
    const context: McpDispatchContext = {
      collections: [],
      environments: [],
      history: [],
      consent: DEFAULT_CONSENT,
    };

    const handle = startStdioMcpServer(() => context);

    expect(stdioState.options).toMatchObject({ legacy: 'serve' });
    expect(stdioState.factory).toBeTypeOf('function');
    expect(stdioState.factory?.()).not.toBe(stdioState.factory?.());

    await handle.stop();
    expect(stdioState.close).toHaveBeenCalledOnce();
  });
});
