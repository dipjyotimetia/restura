import type { McpRequest } from '@/types';

export interface McpGenerateOptions {
  request: McpRequest;
  /** JSON-RPC method to invoke; defaults to defaultMethod or 'tools/list' */
  method?: string;
  /** Params object for the call; will be JSON.stringified */
  params?: unknown;
}

function enabledHeaders(req: McpRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of req.headers) {
    if (h.enabled && h.key.trim()) out[h.key.trim()] = h.value;
  }
  return out;
}

function generateCurl(opts: McpGenerateOptions): string {
  const method = opts.method ?? opts.request.defaultMethod ?? 'tools/list';
  const params = opts.params ?? (opts.request.defaultParams ? JSON.parse(opts.request.defaultParams) : undefined);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    ...(params !== undefined ? { params } : {}),
  });
  const headerArgs = Object.entries({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...enabledHeaders(opts.request),
  })
    .map(([k, v]) => `  -H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(' \\\n');
  return `curl -X POST \\
${headerArgs} \\
  -d ${JSON.stringify(body)} \\
  ${JSON.stringify(opts.request.url)}`;
}

function generateTypeScriptSdk(opts: McpGenerateOptions): string {
  const method = opts.method ?? opts.request.defaultMethod ?? 'tools/list';
  const params = opts.params ?? (opts.request.defaultParams ? JSON.parse(opts.request.defaultParams) : undefined);
  // The transport class to import depends on the chosen MCP transport
  const transportClass = opts.request.transport === 'http-sse'
    ? 'SSEClientTransport'
    : 'StreamableHTTPClientTransport';
  const transportImport = opts.request.transport === 'http-sse'
    ? "@modelcontextprotocol/sdk/client/sse.js"
    : "@modelcontextprotocol/sdk/client/streamableHttp.js";
  return `// npm i @modelcontextprotocol/sdk
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ${transportClass} } from '${transportImport}';

const transport = new ${transportClass}(new URL(${JSON.stringify(opts.request.url)}));
const client = new Client(
  { name: 'restura-generated', version: '1.0.0' },
  { capabilities: {} }
);

await client.connect(transport);

const result = await client.request(
  { method: ${JSON.stringify(method)}${params !== undefined ? `, params: ${JSON.stringify(params)}` : ''} },
  { /* result schema */ } as any
);
console.log(result);

await client.close();`;
}

export const mcpCodeGenerators = {
  curl: { name: 'cURL (raw JSON-RPC)', generate: generateCurl },
  typescriptSdk: { name: 'TypeScript (@modelcontextprotocol/sdk)', generate: generateTypeScriptSdk },
};

export type McpCodeGeneratorType = keyof typeof mcpCodeGenerators;
