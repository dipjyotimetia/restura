import { createServer, type Server } from 'node:http';
import {
  acceptedContent,
  createMcpHandler,
  inputRequired,
  McpServer,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { applyCors, bindLocalhost, closeServer, handlePreflight } from '../utils/serverHelpers';

export interface MockMcpV2ServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
  publishChanges: () => void;
}

const SERVER_INFO = { name: 'restura-mock-mcp-v2', version: '2.0.0' };

/**
 * v2's fetch-native handler serves both protocol eras: default clients receive
 * the legacy initialize flow and auto-negotiating clients receive modern
 * `server/discover`, cache hints, and subscription streams.
 */
export async function startMockMcpV2Server(
  opts: { port?: number } = {}
): Promise<MockMcpV2ServerHandle> {
  const handler = createMcpHandler(({ era }) => {
    const mcp = new McpServer(SERVER_INFO, {
      cacheHints: { 'tools/list': { ttlMs: 1_000, cacheScope: 'private' } },
    });

    mcp.registerTool(
      'echo',
      {
        description: 'Echoes text and reports the negotiated protocol era',
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text }) => ({ content: [{ type: 'text', text: `${era}:${text}` }] })
    );
    mcp.registerTool(
      'add',
      { description: 'Adds two numbers', inputSchema: z.object({ a: z.number(), b: z.number() }) },
      async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
    );
    mcp.registerTool(
      'fail',
      {
        description: 'Returns an MCP tool error result',
        inputSchema: z.object({ reason: z.string() }),
      },
      async ({ reason }) => ({
        content: [{ type: 'text', text: `failed: ${reason}` }],
        isError: true,
      })
    );
    mcp.registerTool(
      'header-echo',
      {
        description: 'Exercises the v2 HTTP-header-capable tool schema path',
        inputSchema: z.object({ value: z.string().meta({ 'x-mcp-header': 'X-Restura-Mock' }) }),
      },
      async ({ value }) => ({ content: [{ type: 'text', text: `header:${value}` }] })
    );
    mcp.registerTool(
      'confirm-deploy',
      {
        description: 'Exercises v2 input_required multi-round trips',
        inputSchema: z.object({ environment: z.string() }),
      },
      async ({ environment }, ctx) => {
        const confirmed = acceptedContent(
          ctx.mcpReq.inputResponses,
          'confirm',
          z.object({ confirm: z.literal(true) })
        );
        if (confirmed) return { content: [{ type: 'text', text: `deployed:${environment}` }] };

        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Deploy to ${environment}?`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean' } },
                required: ['confirm'],
              },
            }),
          },
        });
      }
    );

    mcp.registerResource(
      'readme',
      'restura-v2://readme',
      { title: 'V2 README', description: 'Modern mock resource', mimeType: 'text/markdown' },
      async (uri) => ({
        contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: '# Restura v2 mock' }],
      })
    );
    mcp.registerResource(
      'config',
      'restura-v2://config.json',
      {
        title: 'V2 Config',
        description: 'Modern mock configuration',
        mimeType: 'application/json',
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify({ protocolEra: era, cacheable: true }),
          },
        ],
      })
    );
    mcp.registerPrompt(
      'greet',
      {
        title: 'Greet',
        description: 'Returns a modern greeting prompt',
        argsSchema: z.object({ name: z.string() }),
      },
      ({ name }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name} from ${era}` } }],
      })
    );
    return mcp;
  });
  const nodeHandler = toNodeHandler(handler);
  const server: Server = createServer((req, res) => {
    applyCors(res, {
      methods: 'POST,GET,DELETE,OPTIONS',
      headers: 'content-type, mcp-session-id, mcp-protocol-version',
      exposeHeaders: 'mcp-session-id',
    });
    if (handlePreflight(req, res)) return;
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    void nodeHandler(req, res);
  });
  const port = await bindLocalhost(server, opts.port);

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await handler.close();
      await closeServer(server);
    },
    publishChanges: () => {
      handler.notify.toolsChanged();
      handler.notify.promptsChanged();
      handler.notify.resourcesChanged();
      handler.notify.resourceUpdated('restura-v2://config.json');
    },
  };
}
