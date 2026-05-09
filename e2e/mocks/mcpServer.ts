import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { applyCors, bindLocalhost, closeServer, handlePreflight, readJson } from '../utils/serverHelpers';

export interface MockMcpServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
  methodsReceived: () => string[];
  initializeCount: () => number;
  toolCallCount: () => number;
  reset: () => void;
}

// Hoisted to module scope so each per-request McpServer construction reuses
// the same Zod schemas and metadata objects rather than rebuilding them.
const ECHO_TOOL = {
  name: 'echo' as const,
  config: {
    title: 'Echo',
    description: 'Echoes the input string back',
    inputSchema: { text: z.string() },
  },
};

const ADD_TOOL = {
  name: 'add' as const,
  config: {
    title: 'Add',
    description: 'Adds two numbers',
    inputSchema: { a: z.number(), b: z.number() },
  },
};

// `fail` returns isError: true to exercise the error-result path; clients
// must treat it differently than a JSON-RPC error envelope.
const FAIL_TOOL = {
  name: 'fail' as const,
  config: {
    title: 'Fail',
    description: 'Always returns isError:true with a diagnostic message',
    inputSchema: { reason: z.string() },
  },
};

const RESOURCES = [
  {
    name: 'readme',
    uri: 'restura://readme',
    config: {
      title: 'README',
      description: 'Project overview',
      mimeType: 'text/markdown',
    },
    text: '# restura mock\n\nThis resource exists to test resources/list and resources/read.',
  },
  {
    name: 'config',
    uri: 'restura://config.json',
    config: {
      title: 'Config',
      description: 'Sample JSON config',
      mimeType: 'application/json',
    },
    text: JSON.stringify({ feature: 'mcp', enabled: true }, null, 2),
  },
];

const GREET_PROMPT = {
  name: 'greet' as const,
  config: {
    title: 'Greet',
    description: 'Returns a greeting prompt template',
    argsSchema: { name: z.string() },
  },
};

const SERVER_INFO = { name: 'restura-mock-mcp', version: '0.0.1' };
const SERVER_OPTIONS = {
  capabilities: { tools: {}, resources: {}, prompts: {} },
};

/**
 * Each HTTP request gets a fresh McpServer + Transport pair. The SDK marks
 * its transport binding "connected" after the first call and refuses
 * re-connect — so a shared server across requests breaks the second one.
 */
export async function startMockMcpServer(): Promise<MockMcpServerHandle> {
  const methodsReceived: string[] = [];
  let initializeCount = 0;
  let toolCallCount = 0;

  function buildServer(): McpServer {
    const mcp = new McpServer(SERVER_INFO, SERVER_OPTIONS);

    mcp.registerTool(ECHO_TOOL.name, ECHO_TOOL.config, async ({ text }) => {
      toolCallCount += 1;
      return { content: [{ type: 'text', text: `echo:${text}` }] };
    });
    mcp.registerTool(ADD_TOOL.name, ADD_TOOL.config, async ({ a, b }) => {
      toolCallCount += 1;
      return { content: [{ type: 'text', text: String(a + b) }] };
    });
    mcp.registerTool(FAIL_TOOL.name, FAIL_TOOL.config, async ({ reason }) => {
      toolCallCount += 1;
      return { content: [{ type: 'text', text: `failed: ${reason}` }], isError: true };
    });

    for (const r of RESOURCES) {
      mcp.registerResource(r.name, r.uri, r.config, async (uri) => ({
        contents: [{ uri: uri.toString(), mimeType: r.config.mimeType, text: r.text }],
      }));
    }

    mcp.registerPrompt(GREET_PROMPT.name, GREET_PROMPT.config, ({ name }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Please greet ${name} with enthusiasm.` },
        },
      ],
    }));

    return mcp;
  }

  function recordMethods(body: unknown): void {
    const messages = Array.isArray(body) ? body : [body];
    for (const m of messages) {
      const method = (m as { method?: string } | null)?.method;
      if (typeof method === 'string') {
        methodsReceived.push(method);
        if (method === 'initialize') initializeCount += 1;
      }
    }
  }

  // Synthetic session id surfaced via Mcp-Session-Id so the Restura worker
  // forwards it without us opting into stateful session management.
  const advertisedSessionId = randomUUID();

  const server: Server = createServer((req, res) => {
    void (async () => {
      applyCors(res, {
        methods: 'POST,GET,DELETE,OPTIONS',
        headers: 'content-type, mcp-session-id, mcp-protocol-version',
        exposeHeaders: 'mcp-session-id',
      });
      res.setHeader('mcp-session-id', advertisedSessionId);
      if (handlePreflight(req, res)) return;

      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      const mcp = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);

      let parsedBody: unknown;
      if (req.method === 'POST') {
        parsedBody = await readJson(req);
        recordMethods(parsedBody);
      }
      try {
        await transport.handleRequest(req, res, parsedBody);
      } finally {
        await transport.close().catch(() => {});
        await mcp.close().catch(() => {});
      }
    })().catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  const port = await bindLocalhost(server);

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => closeServer(server),
    methodsReceived: () => methodsReceived.slice(),
    initializeCount: () => initializeCount,
    toolCallCount: () => toolCallCount,
    reset: () => {
      methodsReceived.splice(0, methodsReceived.length);
      initializeCount = 0;
      toolCallCount = 0;
    },
  };
}
