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
  const params =
    opts.params ??
    (opts.request.defaultParams ? JSON.parse(opts.request.defaultParams) : undefined);
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
  const params =
    opts.params ??
    (opts.request.defaultParams ? JSON.parse(opts.request.defaultParams) : undefined);
  const transportClass =
    opts.request.transport === 'http-sse' ? 'SSEClientTransport' : 'StreamableHTTPClientTransport';
  return `// npm i @modelcontextprotocol/client zod
import { Client, ${transportClass} } from '@modelcontextprotocol/client';
import { z } from 'zod';

const transport = new ${transportClass}(new URL(${JSON.stringify(opts.request.url)}));
const client = new Client(
  { name: 'restura-generated', version: '1.0.0' },
  { capabilities: {}, versionNegotiation: { mode: 'auto' } }
);

await client.connect(transport);

const result = await client.request(
  { method: ${JSON.stringify(method)}${params !== undefined ? `, params: ${JSON.stringify(params)}` : ''} },
  z.unknown()
);
console.log(result);

await client.close();`;
}

export const mcpCodeGenerators = {
  curl: { name: 'cURL (raw JSON-RPC)', generate: generateCurl },
  typescriptSdk: {
    name: 'TypeScript (@modelcontextprotocol/client)',
    generate: generateTypeScriptSdk,
  },
};

export type McpCodeGeneratorType = keyof typeof mcpCodeGenerators;
