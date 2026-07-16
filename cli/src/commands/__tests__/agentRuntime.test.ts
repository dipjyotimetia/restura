import { describe, expect, it } from 'vitest';
import { AgentRuntimeManifestSchema } from '../agentRuntime';

describe('AgentRuntimeManifestSchema', () => {
  it('accepts explicitly selected collection and MCP sources', () => {
    const manifest = AgentRuntimeManifestSchema.parse({
      schemaVersion: 1,
      sources: [
        {
          id: 'orders',
          kind: 'collection',
          path: './collections/orders',
          requestIds: ['order-get'],
        },
        {
          id: 'docs',
          kind: 'mcp',
          url: 'https://mcp.example.test/api',
          transport: 'streamable-http',
          readOnly: true,
          headers: [{ name: 'Authorization', env: 'MCP_TOKEN' }],
          allowedTools: ['search_docs'],
        },
      ],
    });

    expect(manifest.sources).toHaveLength(2);
  });

  it('rejects inline MCP header values and duplicate source identifiers', () => {
    const result = AgentRuntimeManifestSchema.safeParse({
      schemaVersion: 1,
      sources: [
        { id: 'orders', kind: 'collection', path: './orders', requestIds: ['get'] },
        {
          id: 'orders',
          kind: 'mcp',
          url: 'https://mcp.example.test/api',
          transport: 'streamable-http',
          readOnly: true,
          headers: [{ name: 'Authorization', value: 'secret' }],
          allowedTools: ['search_docs'],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('requires a human read-only assertion before exposing an MCP source in CI', () => {
    const result = AgentRuntimeManifestSchema.safeParse({
      schemaVersion: 1,
      sources: [
        {
          id: 'docs',
          kind: 'mcp',
          url: 'https://mcp.example.test/api',
          transport: 'streamable-http',
          allowedTools: ['search_docs'],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a request exposed by more than one collection source', () => {
    const result = AgentRuntimeManifestSchema.safeParse({
      schemaVersion: 1,
      sources: [
        { id: 'orders', kind: 'collection', path: './orders', requestIds: ['get-order'] },
        { id: 'archive', kind: 'collection', path: './archive', requestIds: ['get-order'] },
      ],
    });

    expect(result.success).toBe(false);
  });
});
