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

describe('MCP stdio code generation', () => {
  const stdioRequest: McpRequest = {
    ...request('stdio'),
    url: '',
    stdio: {
      command: 'npx',
      args: ['-y', '', '@scope/server'],
      cwd: '/srv',
      env: [{ id: 'e', key: 'TOKEN', value: 'secret-value', enabled: true }],
    },
  };

  it('emits a StdioClientTransport client without env values', () => {
    const generated = mcpCodeGenerators.typescriptSdk.generate({ request: stdioRequest });
    expect(generated).toContain(
      "import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';"
    );
    expect(generated).toContain('command: "npx"');
    expect(generated).toContain('args: ["-y","@scope/server"]');
    expect(generated).toContain('cwd: "/srv"');
    expect(generated).not.toContain('secret-value');
  });

  it('omits cwd when unset', () => {
    const { cwd: _cwd, ...noCwd } = stdioRequest.stdio!;
    const generated = mcpCodeGenerators.typescriptSdk.generate({
      request: { ...stdioRequest, stdio: noCwd },
    });
    expect(generated).not.toContain('cwd:');
  });

  it('explains that there is no cURL equivalent', () => {
    expect(mcpCodeGenerators.curl.generate({ request: stdioRequest })).toMatch(
      /no HTTP request to express as cURL/
    );
  });
});
