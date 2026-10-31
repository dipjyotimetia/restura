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

  it('classifies destructive, open-world and unannotated tools and lets callers inspect them', async () => {
    const inspected: string[][] = [];
    const tools = await createMcpTools(
      { kind: 'mcp', connectionId: 'server' },
      {
        async listTools() {
          return [
            { name: 'drop', inputSchema: {}, annotations: { destructiveHint: true } },
            { name: 'fetch', inputSchema: {}, annotations: { openWorldHint: true } },
            { name: 'plain', inputSchema: {} },
          ];
        },
        async callTool(name) {
          return [{ type: 'text', text: name }];
        },
      },
      undefined,
      {
        nameForTool: (name) => `mcp_${name}`,
        inspectDescriptors: (descriptors) => inspected.push(descriptors.map((d) => d.name)),
      }
    );
    expect(tools.map((tool) => [tool.definition.name, tool.permissionClass])).toEqual([
      ['mcp_drop', 'destructive'],
      ['mcp_fetch', 'network'],
      ['mcp_plain', 'mutation'],
    ]);
    expect(inspected).toEqual([['drop', 'fetch', 'plain']]);
  });

  it('fails closed when an explicitly allowed remote tool is unavailable', async () => {
    await expect(
      createMcpTools(
        { kind: 'mcp', connectionId: 'server', allowedTools: ['read'] },
        {
          async listTools() {
            return [];
          },
          async callTool() {
            return [];
          },
        }
      )
    ).rejects.toThrow('did not expose allowed tools: read');
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
