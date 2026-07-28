// @vitest-environment node

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { type MockMcpV2ServerHandle, startMockMcpV2Server } from '../e2e/mocks/mcpV2Server';

let server: MockMcpV2ServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('v2 MCP mock server', () => {
  it('serves the modern protocol era with the v2 capability catalogue', async () => {
    server = await startMockMcpV2Server();
    const client = new Client(
      { name: 'restura-v2-mock-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } }
    );

    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

    expect(client.getProtocolEra()).toBe('modern');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'add',
      'confirm-deploy',
      'echo',
      'fail',
      'header-echo',
    ]);

    await client.close();
  });

  it('exercises modern tools, resources, and prompts over the live v2 wire', async () => {
    server = await startMockMcpV2Server();
    const client = new Client(
      { name: 'restura-v2-mock-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

    const echo = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    expect(echo.content).toEqual([{ type: 'text', text: 'modern:hello' }]);

    const headerEcho = await client.callTool({
      name: 'header-echo',
      arguments: { value: 'mirrored' },
    });
    expect(headerEcho.content).toEqual([{ type: 'text', text: 'header:mirrored' }]);

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      'restura-v2://config.json',
      'restura-v2://readme',
    ]);
    const { contents } = await client.readResource({ uri: 'restura-v2://config.json' });
    expect(JSON.parse((contents[0] as { text: string }).text)).toEqual({
      protocolEra: 'modern',
      cacheable: true,
    });

    const prompt = await client.getPrompt({ name: 'greet', arguments: { name: 'Ada' } });
    expect(prompt.messages[0]?.content).toEqual({ type: 'text', text: 'Hello Ada from modern' });

    await client.close();
  });

  it('drives modern multi-round input and subscription notifications', async () => {
    server = await startMockMcpV2Server();
    const client = new Client(
      { name: 'restura-v2-mock-test', version: '1.0.0' },
      {
        capabilities: { elicitation: {} },
        inputRequired: { autoFulfill: true },
        versionNegotiation: { mode: 'auto' },
      }
    );
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: { confirm: true },
    }));
    const toolsChanged = new Promise<void>((resolve) => {
      client.setNotificationHandler('notifications/tools/list_changed', () => resolve());
    });

    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

    const deploy = await client.callTool({
      name: 'confirm-deploy',
      arguments: { environment: 'test' },
    });
    expect(deploy.content).toEqual([{ type: 'text', text: 'deployed:test' }]);

    const subscription = await client.listen({ toolsListChanged: true });
    server.publishChanges();
    await toolsChanged;

    await subscription.close();
    await client.close();
  });
});
