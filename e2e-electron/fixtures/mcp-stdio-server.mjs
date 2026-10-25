#!/usr/bin/env node
// Tiny MCP server over stdio for the stdio-transport tests (#854).
// Used by the e2e-electron smoke (e2e-electron/specs/mcp-stdio.spec.ts) and the
// Vitest integration test (electron/main/__tests__/mcp-stdio.integration.test.ts).
//
// Tools:
//   echo     — returns its text
//   pid      — returns this process's pid (tests assert it is gone after disconnect)
//   env-keys — returns the sorted NAMES of the env vars it received (never values)
//   client-caps — returns the capabilities the client advertised (JSON)
//   roots    — asks the client for roots/list and returns the root URIs
//
// If MCP_STDIO_FIXTURE_MARKER is set, the pid is appended to that file on start
// so a test can prove that a denied launch never spawned anything.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

if (process.env.MCP_STDIO_FIXTURE_MARKER) {
  appendFileSync(process.env.MCP_STDIO_FIXTURE_MARKER, `${process.pid}\n`);
}

const server = new McpServer({ name: 'restura-stdio-fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  { description: 'Echoes text', inputSchema: z.object({ text: z.string() }) },
  async ({ text }) => ({ content: [{ type: 'text', text }] })
);
server.registerTool('pid', { description: 'Reports the server pid' }, async () => ({
  content: [{ type: 'text', text: String(process.pid) }],
}));
server.registerTool(
  'env-keys',
  { description: 'Lists received environment variable names' },
  async () => ({ content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }] })
);

server.registerTool('client-caps', { description: 'Reports client capabilities' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify(server.server.getClientCapabilities() ?? {}) }],
}));
server.registerTool('roots', { description: 'Lists the client roots' }, async () => {
  const { roots } = await server.server.listRoots();
  return { content: [{ type: 'text', text: roots.map((root) => root.uri).join(',') }] };
});

process.stderr.write('restura stdio fixture ready\n');
await server.connect(new StdioServerTransport());
