/**
 * Agentic AI tools — the actions the assistant may propose and the user may
 * apply. Each tool exposes a JSON-Schema definition (sent to the provider) and
 * a `run` that mutates renderer state via the Zustand stores.
 *
 * The consent model is "propose & apply": the model emits a tool call, the
 * ChatPanel renders it as a card, and nothing mutates until the user clicks
 * Apply — which invokes `runAgentTool`. There is no automatic execution and no
 * multi-turn provider continuation in this version (documented as the next
 * increment).
 */
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { useRequestStore } from '@/store/useRequestStore';
import type { AiToolDef } from '@shared/protocol/ai/types';
import type { HttpRequest, KeyValue, Request } from '@/types';

export type ToolResult = { ok: true; summary: string } | { ok: false; error: string };

export interface AgentTool {
  def: AiToolDef;
  run(rawInput: string): ToolResult;
}

function parseInput<T>(
  schema: z.ZodType<T>,
  raw: string
): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Tool input was not valid JSON' };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, value: parsed.data };
}

function toKeyValues(pairs?: Array<{ key: string; value: string }>): KeyValue[] {
  return (pairs ?? []).map((p) => ({ id: uuidv4(), key: p.key, value: p.value, enabled: true }));
}

// --- create_http_request -----------------------------------------------------

const createReqSchema = z.object({
  method: z.string().default('GET'),
  url: z.string().min(1),
  name: z.string().optional(),
  headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  body: z.string().optional(),
});

const createHttpRequest: AgentTool = {
  def: {
    name: 'create_http_request',
    description:
      'Create a new HTTP request tab with the given method, URL, optional headers and JSON body.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        method: { type: 'string', description: 'HTTP method, e.g. GET or POST' },
        url: { type: 'string', description: 'Full request URL' },
        name: { type: 'string', description: 'Optional tab/request name' },
        headers: {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
        },
        body: { type: 'string', description: 'Optional raw request body (JSON text)' },
      },
    },
  },
  run(raw) {
    const parsed = parseInput(createReqSchema, raw);
    if (!parsed.ok) return parsed;
    const input = parsed.value;
    const req: HttpRequest = {
      id: uuidv4(),
      name: input.name ?? 'AI request',
      type: 'http',
      method: input.method.toUpperCase() as HttpRequest['method'],
      url: input.url,
      headers: toKeyValues(input.headers),
      params: [],
      body: input.body ? { type: 'json', raw: input.body } : { type: 'none' },
      auth: { type: 'none' },
    };
    useRequestStore.getState().openTab(req, { switchTo: true });
    return { ok: true, summary: `Opened ${req.method} ${req.url}` };
  },
};

// --- set_test_script ----------------------------------------------------------

const setScriptSchema = z.object({ script: z.string().min(1) });

const setTestScript: AgentTool = {
  def: {
    name: 'set_test_script',
    description:
      "Set the test script (rs.test assertions) on the active HTTP request. Use Restura's native rs.* assertions (Postman-compatible; pm.* also works as an alias).",
    inputSchema: {
      type: 'object',
      required: ['script'],
      properties: { script: { type: 'string', description: 'JavaScript test script body' } },
    },
  },
  run(raw) {
    const parsed = parseInput(setScriptSchema, raw);
    if (!parsed.ok) return parsed;
    const st = useRequestStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab || tab.request.type !== 'http') {
      return { ok: false, error: 'No active HTTP request to attach a test script to' };
    }
    st.updateRequest({ testScript: parsed.value.script } as Partial<Request>);
    return { ok: true, summary: 'Updated the active request’s test script' };
  },
};

export const AGENT_TOOLS: AgentTool[] = [createHttpRequest, setTestScript];

/** Tool definitions to advertise to the provider in the chat request. */
export function agentToolDefs(): AiToolDef[] {
  return AGENT_TOOLS.map((t) => t.def);
}

/** Execute a tool call by name. Returns a human-readable result. */
export function runAgentTool(name: string, rawInput: string): ToolResult {
  const tool = AGENT_TOOLS.find((t) => t.def.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  return tool.run(rawInput);
}
