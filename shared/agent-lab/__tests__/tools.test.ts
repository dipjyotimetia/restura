import { describe, expect, it } from 'vitest';
import { createMcpTools, SandboxRegistry } from '../tools';

describe('MCP agent tools', () => {
  it('honours allowlists and maps MCP safety annotations to approvals', async () => {
    const tools = await createMcpTools(
      { kind: 'mcp', connectionId: 'server', allowedTools: ['read'] },
      {
        async listTools() {
          return [
            {
              name: 'read',
              description: 'read',
              inputSchema: {},
              annotations: { readOnlyHint: true },
            },
            {
              name: 'delete',
              description: 'delete',
              inputSchema: {},
              annotations: { destructiveHint: true },
            },
          ];
        },
        async callTool(name) {
          return [{ type: 'text', text: name }];
        },
      }
    );
    expect(tools.map((tool) => tool.definition.name)).toEqual(['read']);
    expect(tools[0]?.permissionClass).toBe('mutation');
  });
});

describe('sandbox registry', () => {
  it('is pluggable and rejects duplicate provider ids', () => {
    const provider = {
      id: 'docker',
      async execute() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const registry = new SandboxRegistry([provider]);
    expect(registry.require('docker')).toBe(provider);
    expect(() => registry.register(provider)).toThrow('duplicate sandbox provider');
  });
});
