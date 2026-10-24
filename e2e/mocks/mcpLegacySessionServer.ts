import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  applyCors,
  bindLocalhost,
  closeServer,
  handlePreflight,
  readJson,
} from '../utils/serverHelpers';

/**
 * Sessionful 2025-era (legacy) MCP mock. Unlike `mcpServer.ts` (stateless, a
 * fresh server per request) and the v2 mock's stateless legacy fallback, this
 * keeps one McpServer per `Mcp-Session-Id`, so the client's GET SSE stream can
 * receive unsolicited server pushes: `resources/updated` for subscribed URIs,
 * `list_changed`, and `notifications/message` log lines (#858, #872).
 */
export interface MockMcpLegacySessionServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
  /** URIs currently subscribed via `resources/subscribe` (all sessions). */
  subscribedUris: () => string[];
  /** Push `notifications/resources/updated` for `uri` to every session subscribed to it. */
  publishResourceUpdated: (uri: string) => Promise<void>;
  /** Push `notifications/tools/list_changed` to every session. */
  publishToolsChanged: () => Promise<void>;
  /** Push a `notifications/message` log line to every session. */
  publishLog: (level: 'info' | 'warning' | 'error', data: unknown) => Promise<void>;
  /** Drop every session transport (simulates the server going away). */
  dropSessions: () => Promise<void>;
}

const SERVER_INFO = { name: 'restura-mock-mcp-legacy-session', version: '0.0.1' };

interface Session {
  mcp: McpServer;
  transport: NodeStreamableHTTPServerTransport;
  subscribed: Set<string>;
}

export async function startMockMcpLegacySessionServer(
  opts: { port?: number } = {}
): Promise<MockMcpLegacySessionServerHandle> {
  const sessions = new Map<string, Session>();

  function buildSession(): Session {
    const subscribed = new Set<string>();
    const mcp = new McpServer(SERVER_INFO, {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        logging: {},
      },
    });
    mcp.registerTool(
      'slow-count',
      {
        description: 'Reports progress for each step, then returns the count',
        inputSchema: z.object({ steps: z.number() }),
      },
      async ({ steps }, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        for (let i = 1; i <= steps; i++) {
          if (progressToken !== undefined) {
            await ctx.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken, progress: i, total: steps, message: `step ${i}` },
            });
          }
        }
        return { content: [{ type: 'text', text: `counted:${steps}` }] };
      }
    );
    mcp.registerResource(
      'config',
      'restura-legacy://config.json',
      { title: 'Config', mimeType: 'application/json' },
      async (uri) => ({
        contents: [{ uri: uri.toString(), mimeType: 'application/json', text: '{"v":1}' }],
      })
    );
    mcp.server.setRequestHandler('resources/subscribe', async (request) => {
      subscribed.add(request.params.uri);
      return {};
    });
    mcp.server.setRequestHandler('resources/unsubscribe', async (request) => {
      subscribed.delete(request.params.uri);
      return {};
    });
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const session: Session = { mcp, transport, subscribed };
    return session;
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      applyCors(res, {
        methods: 'POST,GET,DELETE,OPTIONS',
        headers: 'content-type, mcp-session-id, mcp-protocol-version, last-event-id',
        exposeHeaders: 'mcp-session-id',
      });
      if (handlePreflight(req, res)) return;
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      // Modern probes (`server/discover`) are rejected so the client falls
      // back to the 2025 initialize handshake.
      const parsedBody = req.method === 'POST' ? await readJson(req) : undefined;
      const sessionId = req.headers['mcp-session-id'];
      let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!session) {
        const method = (parsedBody as { method?: string } | undefined)?.method;
        if (method !== 'initialize') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: (parsedBody as { id?: unknown } | undefined)?.id ?? null,
              error: { code: -32600, message: 'Bad Request: no valid session' },
            })
          );
          return;
        }
        session = buildSession();
        await session.mcp.connect(session.transport);
      }
      await session.transport.handleRequest(req, res, parsedBody);
    })().catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  const port = await bindLocalhost(server, opts.port);

  const dropSessions = async () => {
    const all = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(all.map((s) => s.mcp.close()));
  };

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await dropSessions();
      await closeServer(server);
    },
    subscribedUris: () => [...sessions.values()].flatMap((s) => [...s.subscribed]),
    publishResourceUpdated: async (uri) => {
      await Promise.all(
        [...sessions.values()]
          .filter((s) => s.subscribed.has(uri))
          .map((s) => s.mcp.server.sendResourceUpdated({ uri }))
      );
    },
    publishToolsChanged: async () => {
      await Promise.all([...sessions.values()].map((s) => s.mcp.server.sendToolListChanged()));
    },
    publishLog: async (level, data) => {
      await Promise.all(
        [...sessions.values()].map((s) => s.mcp.server.sendLoggingMessage({ level, data }))
      );
    },
    dropSessions,
  };
}
