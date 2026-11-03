/**
 * Agentic AI tools — the actions the assistant may propose and the user may
 * apply. Each tool exposes a JSON-Schema definition (sent to the provider) and
 * a `run` that mutates renderer state via the Zustand stores.
 *
 * The consent model is "propose & apply": the model emits a tool call, the
 * ChatPanel renders it as a card, and nothing mutates until the user clicks
 * Apply — which invokes `runAgentTool`. There is no automatic execution.
 *
 * These tools are also driven by the inline AI actions (Fix request / Generate
 * tests / Enrich docs — see lib/inlineActions.ts) and by Agent Mode, a bounded
 * multi-step loop (agent/agentSession.ts) that continues by re-sending over the
 * existing ai:chat channel after each user-approved step. Strict propose-&-apply
 * holds throughout: every mutation still waits for an explicit Apply.
 */

import type { AiToolDef } from '@shared/protocol/ai/types';
import { checkHttpMethod } from '@shared/protocol/http-method';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest, KeyValue, Request } from '@/types';

export type AgentToolResult = { ok: true; summary: string } | { ok: false; error: string };

export interface AgentTool {
  def: AiToolDef;
  run(rawInput: string): AgentToolResult;
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

/**
 * What redaction writes in place of a secret before the context reaches the
 * model (`shared/protocol/ai/redaction.ts`, promptBuilder). A proposed value
 * carrying it is a stand-in for a value the model never saw, never a value to
 * write: the original is kept.
 */
const REDACTION_PLACEHOLDER = '[REDACTED]';
const carriesPlaceholder = (value: string): boolean => value.includes(REDACTION_PLACEHOLDER);

/**
 * Apply a model-proposed key/value list onto the current rows. The model only
 * saw the enabled rows, with secrets redacted, so: disabled rows stay as they
 * are; enabled rows are matched by key (in order) and keep their id,
 * description and flags, and their value when the proposal carries the
 * placeholder; enabled rows the proposal omits are removed; unmatched
 * proposals are appended, except a placeholder value (nothing to restore).
 */
function mergeKeyValues(
  current: readonly KeyValue[],
  proposed: ReadonlyArray<{ key: string; value: string }>,
  keyOf: (key: string) => string
): KeyValue[] {
  const pending = new Map<string, Array<{ key: string; value: string }>>();
  for (const pair of proposed) {
    const k = keyOf(pair.key);
    const queue = pending.get(k);
    if (queue) queue.push(pair);
    else pending.set(k, [pair]);
  }
  const merged: KeyValue[] = [];
  for (const row of current) {
    if (!row.enabled) {
      merged.push(row);
      continue;
    }
    const match = pending.get(keyOf(row.key))?.shift();
    if (!match) continue;
    merged.push(carriesPlaceholder(match.value) ? row : { ...row, value: match.value });
  }
  for (const queue of pending.values()) {
    for (const pair of queue) {
      if (!carriesPlaceholder(pair.value)) merged.push(...toKeyValues([pair]));
    }
  }
  return merged;
}

const headerKey = (key: string): string => key.trim().toLowerCase();
const paramKey = (key: string): string => key.trim();

/**
 * The active tab, narrowed to an HTTP request, or null. Shared by the tools
 * that mutate the request currently in focus so the `type === 'http'` guard
 * (and its error message) lives in one place.
 */
function activeHttpTab(): { request: HttpRequest } | null {
  const st = useRequestStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  if (tab?.request.type !== 'http') return null;
  return { request: tab.request };
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
    const method = checkHttpMethod(input.method);
    if (!method.ok) return { ok: false, error: method.error };
    const req: HttpRequest = {
      id: uuidv4(),
      name: input.name ?? 'AI request',
      type: 'http',
      method: method.method,
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
    if (tab?.request.type !== 'http') {
      return { ok: false, error: 'No active HTTP request to attach a test script to' };
    }
    if (!st.updateRequest({ testScript: parsed.value.script } as Partial<Request>)) {
      return { ok: false, error: 'The test script update was rejected' };
    }
    return { ok: true, summary: 'Updated the active request’s test script' };
  },
};

// --- update_http_request ------------------------------------------------------

const updateReqSchema = z
  .object({
    method: z.string().optional(),
    url: z.string().min(1).optional(),
    name: z.string().optional(),
    headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    params: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    body: z.string().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Specify at least one field to update',
  });

const updateHttpRequest: AgentTool = {
  def: {
    name: 'update_http_request',
    description:
      'Update fields of the ACTIVE HTTP request in place — used to fix a broken request. ' +
      'Only include the fields you want to change; omitted fields are left untouched. ' +
      'Supplying `headers` or `params` replaces the enabled entries of that list, matched ' +
      'by key, so include every entry that should remain; disabled entries are kept. A ' +
      'value containing [REDACTED] keeps the current value. Supplying `body` replaces the ' +
      'raw body text (the body type is preserved for json/text/xml/graphql; other types ' +
      'become json) unless it contains [REDACTED], which keeps the current body.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'New HTTP method, e.g. GET or POST' },
        url: { type: 'string', description: 'New full request URL' },
        name: { type: 'string', description: 'New request/tab name' },
        headers: {
          type: 'array',
          description: 'Header list; enabled entries are replaced, matched by key',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
        },
        params: {
          type: 'array',
          description: 'Query-parameter list; enabled entries are replaced, matched by key',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
        },
        body: { type: 'string', description: 'New raw request body (JSON text)' },
      },
    },
  },
  run(raw) {
    const parsed = parseInput(updateReqSchema, raw);
    if (!parsed.ok) return parsed;
    const active = activeHttpTab();
    if (!active) return { ok: false, error: 'No active HTTP request to update' };

    const input = parsed.value;
    const update: Partial<HttpRequest> = {};
    if (input.method !== undefined) {
      // Same token/denylist policy as the wire (#857) — refuse CONNECT/TRACE/TRACK.
      const method = checkHttpMethod(input.method);
      if (!method.ok) return { ok: false, error: method.error };
      update.method = method.method;
    }
    const kept: string[] = [];
    if (input.url !== undefined) {
      if (carriesPlaceholder(input.url)) kept.push('url');
      else update.url = input.url;
    }
    if (input.name !== undefined) update.name = input.name;
    if (input.headers !== undefined) {
      update.headers = mergeKeyValues(active.request.headers, input.headers, headerKey);
    }
    if (input.params !== undefined) {
      update.params = mergeKeyValues(active.request.params, input.params, paramKey);
    }
    if (input.body !== undefined && carriesPlaceholder(input.body)) {
      kept.push('body');
    } else if (input.body !== undefined) {
      // Preserve the current body type for raw-text bodies instead of forcing
      // json — clobbering an xml/graphql/text body's type silently changed how
      // it serialised. Non-raw bodies (form-data/binary/multipart/none) have no
      // raw representation, so a raw-text update becomes json.
      const cur = active.request.body;
      const RAW_TYPES: ReadonlyArray<string> = ['json', 'text', 'xml', 'graphql'];
      update.body = RAW_TYPES.includes(cur.type)
        ? { ...cur, raw: input.body }
        : { type: 'json', raw: input.body };
    }

    if (Object.keys(update).length === 0) {
      return {
        ok: false,
        error: `Nothing was applied: the proposed ${kept.join(' and ')} contained the ${REDACTION_PLACEHOLDER} placeholder, so the current value was kept`,
      };
    }

    // updateRequest validates the merged request and returns false if it was
    // rejected (e.g. an unsupported method) — don't report success in that case,
    // or Agent Mode would advance on a change that never landed.
    const applied = useRequestStore.getState().updateRequest(update as Partial<Request>);
    if (!applied) {
      return { ok: false, error: 'The update was rejected as invalid (check the method/fields)' };
    }
    const changed = Object.keys(update).join(', ');
    const keptNote =
      kept.length > 0 ? `; kept the current ${kept.join(' and ')} (redacted in the proposal)` : '';
    return { ok: true, summary: `Updated the active request (${changed})${keptNote}` };
  },
};

// --- enrich_docs --------------------------------------------------------------

const enrichDocsSchema = z.object({ documentation: z.string().min(1) });

const enrichDocs: AgentTool = {
  def: {
    name: 'enrich_docs',
    description:
      'Set the markdown documentation/description of the ACTIVE HTTP request. Summarise ' +
      'what the request does, its parameters, and an example of the response. This appears ' +
      'in generated collection docs.',
    inputSchema: {
      type: 'object',
      required: ['documentation'],
      properties: {
        documentation: { type: 'string', description: 'Markdown documentation for the request' },
      },
    },
  },
  run(raw) {
    const parsed = parseInput(enrichDocsSchema, raw);
    if (!parsed.ok) return parsed;
    const active = activeHttpTab();
    if (!active) return { ok: false, error: 'No active HTTP request to document' };
    const applied = useRequestStore
      .getState()
      .updateRequest({ description: parsed.value.documentation } as Partial<Request>);
    if (!applied) return { ok: false, error: 'The documentation update was rejected' };
    return { ok: true, summary: 'Updated the active request’s documentation' };
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  createHttpRequest,
  setTestScript,
  updateHttpRequest,
  enrichDocs,
];

/** Tool definitions to advertise to the provider in the chat request. */
export function agentToolDefs(): AiToolDef[] {
  return AGENT_TOOLS.map((t) => t.def);
}

/** Execute a tool call by name. Returns a human-readable result. */
export function runAgentTool(name: string, rawInput: string): AgentToolResult {
  const tool = AGENT_TOOLS.find((t) => t.def.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  return tool.run(rawInput);
}
