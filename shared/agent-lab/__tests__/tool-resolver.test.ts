import { describe, expect, it } from 'vitest';
import type { ToolSource } from '../index';
import { createAgentToolResolver, type AgentToolSourceAdapter } from '../tool-resolver';

function adapter(kind: ToolSource['kind'], toolName: string): AgentToolSourceAdapter {
  return {
    kind,
    async resolve() {
      return [
        {
          definition: {
            name: toolName,
            description: toolName,
            inputSchema: { type: 'object', additionalProperties: false },
          },
          permissionClass: 'read',
          async execute() {
            return [];
          },
        },
      ];
    },
  };
}

describe('AgentToolResolver', () => {
  it('validates supported sources and resolves them in the suite-declared order', async () => {
    const resolver = createAgentToolResolver([
      adapter('fixture', 'fixture_tool'),
      adapter('restura-request', 'request_tool'),
    ]);
    const sources: ToolSource[] = [
      { kind: 'restura-request', requestId: 'request-1' },
      { kind: 'fixture', fixtureId: 'fixture-1' },
    ];

    expect(() => resolver.assertSupported(sources)).not.toThrow();
    await expect(resolver.resolve(sources)).resolves.toMatchObject([
      { definition: { name: 'request_tool' } },
      { definition: { name: 'fixture_tool' } },
    ]);
  });

  it('rejects an unregistered source kind before resolving any adapter', async () => {
    let resolved = false;
    const resolver = createAgentToolResolver([
      {
        ...adapter('fixture', 'fixture_tool'),
        async resolve(source) {
          resolved = true;
          return adapter('fixture', 'fixture_tool').resolve(source);
        },
      },
    ]);

    const sources: ToolSource[] = [
      { kind: 'fixture', fixtureId: 'fixture-1' },
      { kind: 'mcp', connectionId: 'connection-1' },
    ];

    expect(() => resolver.assertSupported(sources)).toThrow(
      /mcp tool sources need their runtime adapter/i
    );
    await expect(resolver.resolve(sources)).rejects.toThrow(
      /mcp tool sources need their runtime adapter/i
    );
    expect(resolved).toBe(false);
  });
});
