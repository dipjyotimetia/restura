import { describe, expect, it } from 'vitest';
import type { McpRequest } from '@/types';
import { mcpCodeGenerators } from './mcp';

function request(transport: McpRequest['transport']): McpRequest {
  return {
    id: 'mcp-1',
    name: 'MCP',
    type: 'mcp',
    url: 'https://mcp.example.test/mcp',
    transport,
    headers: [],
    auth: { type: 'none' },
  };
}

describe('MCP TypeScript code generator', () => {
  it.each([
    ['streamable-http', 'StreamableHTTPClientTransport'],
    ['http-sse', 'SSEClientTransport'],
  ] as const)('generates a runnable v2 %s client', (transport, transportClass) => {
    const generated = mcpCodeGenerators.typescriptSdk.generate({
      request: request(transport),
      method: 'custom/inspect',
      params: { id: 7 },
    });

    expect(mcpCodeGenerators.typescriptSdk.name).toBe('TypeScript (@modelcontextprotocol/client)');
    expect(generated).toContain('npm i @modelcontextprotocol/client zod');
    expect(generated).toContain(
      `import { Client, ${transportClass} } from '@modelcontextprotocol/client';`
    );
    expect(generated).toContain("import { z } from 'zod';");
    expect(generated).toContain("versionNegotiation: { mode: 'auto' }");
    expect(generated).toContain('z.unknown()');
    expect(generated).not.toContain('@modelcontextprotocol/sdk');
    expect(generated).not.toContain('as any');
  });
});
