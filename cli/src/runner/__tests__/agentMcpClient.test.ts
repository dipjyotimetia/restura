import { afterEach, describe, expect, it } from 'vitest';
import {
  type MockMcpV2ServerHandle,
  startMockMcpV2Server,
} from '../../../../e2e/mocks/mcpV2Server';
import { connectCliMcpClient } from '../agentMcpClient';

let server: MockMcpV2ServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('connectCliMcpClient', () => {
  it('connects to a modern-only server and executes tools through the v2 protocol', async () => {
    server = await startMockMcpV2Server({ legacy: 'reject' });

    const client = await connectCliMcpClient(
      {
        id: 'modern',
        kind: 'mcp',
        url: server.url,
        transport: 'streamable-http',
        headers: [],
        readOnly: true,
        allowedTools: ['echo'],
      },
      {
        environment: {},
        allowLocalhost: true,
        timeoutMs: 5_000,
      }
    );

    await expect(client.listTools()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'echo' })])
    );
    await expect(client.callTool('echo', { text: 'hello' })).resolves.toEqual([
      {
        type: 'json',
        value: expect.objectContaining({
          content: [{ type: 'text', text: 'modern:hello' }],
        }),
      },
    ]);

    await client.dispose();
  });
});
