/**
 * Pure tool-dispatch for the MCP server.
 *
 * The Electron-side handler wires the MCP SDK transport to this module —
 * it forwards JSON-RPC tool invocations here, and we return the JSON
 * payload that becomes the agent-visible tool output.
 *
 * Why pure: the dispatch logic is the load-bearing part of the feature
 * (input validation, consent gating, redaction). Keeping it free of
 * Electron / SDK / transport machinery lets us cover it 100% in
 * Vitest without needing a real Electron process or MCP client.
 *
 * v1 exposes read-only tools:
 *   - list_collections
 *   - list_requests
 *   - get_history
 *   - get_environment
 *   - list_environments
 *
 * `execute_request` is deferred — it needs an architectural decision
 * about whether main proxies the call back to the renderer or runs its
 * own copy of the request executor. See ADR-0011 (MCP server mode).
 */

import { z } from 'zod';
import type { Collection, CollectionItem, Environment, HistoryItem, HttpRequest } from '@/types';
import {
  canExecute,
  canRead,
  canReadEnvironment,
  canReadHistory,
  type McpServerConsent,
} from './consent';
import { redactEnvironmentVariables, redactSecretsDeep } from './redaction';

// ---------------------------------------------------------------------------
// Context — read-only data injected by the host
// ---------------------------------------------------------------------------

/**
 * Read-only snapshot the dispatcher operates against. The host (Electron
 * main process) is responsible for assembling this — typically by reading
 * file-backed collections off disk or pulling from a Zustand-store sync.
 */
export interface McpDispatchContext {
  collections: Collection[];
  environments: Environment[];
  history: HistoryItem[];
  consent: McpServerConsent;
}

// ---------------------------------------------------------------------------
// Tool inputs (Zod-validated at the SDK boundary)
// ---------------------------------------------------------------------------

export const ListCollectionsInputSchema = z.object({});
export const ListRequestsInputSchema = z.object({
  collectionId: z.string().min(1),
  folderPath: z.string().optional(),
});
export const GetHistoryInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  filter: z.string().optional(),
});
export const GetEnvironmentInputSchema = z.object({
  id: z.string().min(1),
});
export const ListEnvironmentsInputSchema = z.object({});

// ---------------------------------------------------------------------------
// Tool registry — every tool exposes its name, Zod schema, and description
// ---------------------------------------------------------------------------

export interface McpToolDefinition<TInput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
}

export const TOOLS = {
  list_collections: {
    name: 'list_collections',
    description:
      'List collections the user has shared with the agent. Returns id, name, request count, and the consent level. Hidden collections are filtered out.',
    inputSchema: ListCollectionsInputSchema,
  } satisfies McpToolDefinition<z.infer<typeof ListCollectionsInputSchema>>,

  list_requests: {
    name: 'list_requests',
    description:
      'List requests inside a collection. Optionally filter by folder path (e.g. "users/auth"). Returns request metadata only — no plaintext secrets.',
    inputSchema: ListRequestsInputSchema,
  } satisfies McpToolDefinition<z.infer<typeof ListRequestsInputSchema>>,

  get_history: {
    name: 'get_history',
    description:
      'Read recent request history. Requires the user to have opted-in to history access. Most-recent first, capped at `limit` (default 50, max 500). `filter` matches against the URL or request name (substring, case-insensitive).',
    inputSchema: GetHistoryInputSchema,
  } satisfies McpToolDefinition<z.infer<typeof GetHistoryInputSchema>>,

  get_environment: {
    name: 'get_environment',
    description:
      'Read an environment by id. The environment must be opted-in for MCP access. Variables flagged as `secret: true` are returned with the value "(secret)" — the agent can ask the user to set them but never reads plaintext.',
    inputSchema: GetEnvironmentInputSchema,
  } satisfies McpToolDefinition<z.infer<typeof GetEnvironmentInputSchema>>,

  list_environments: {
    name: 'list_environments',
    description:
      'List environments the user has opted-in for MCP access. Returns id, name, and variable count. Hidden environments are filtered out.',
    inputSchema: ListEnvironmentsInputSchema,
  } satisfies McpToolDefinition<z.infer<typeof ListEnvironmentsInputSchema>>,
} as const;

export type ToolName = keyof typeof TOOLS;

// ---------------------------------------------------------------------------
// Result shape — `ok: true | false` + Zod-validated payloads
// ---------------------------------------------------------------------------

export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; details?: unknown };

// ---------------------------------------------------------------------------
// Dispatch — pure function
// ---------------------------------------------------------------------------

/**
 * Dispatch a tool call. Returns the agent-visible payload — secrets are
 * redacted before this function ever returns.
 *
 * `name` is matched against {@link TOOLS}; an unknown name returns an
 * `ok: false` result with a clear error.
 */
export function dispatchTool(name: string, rawInput: unknown, ctx: McpDispatchContext): ToolResult {
  switch (name) {
    case 'list_collections':
      return listCollections(ListCollectionsInputSchema, rawInput, ctx);
    case 'list_requests':
      return listRequests(ListRequestsInputSchema, rawInput, ctx);
    case 'get_history':
      return getHistory(GetHistoryInputSchema, rawInput, ctx);
    case 'get_environment':
      return getEnvironment(GetEnvironmentInputSchema, rawInput, ctx);
    case 'list_environments':
      return listEnvironments(ListEnvironmentsInputSchema, rawInput, ctx);
    case 'execute_request':
      // Future tool — gated by `canExecute`. v1 always refuses.
      return {
        ok: false,
        error:
          'execute_request is not enabled in this build. The MCP server v1 ships read-only tools; subscribe to the v2 milestone for execution support.',
      };
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function parse<T>(
  schema: z.ZodType<T>,
  raw: unknown
): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: `Invalid input: ${result.error.message}` };
  }
  return { ok: true, data: result.data };
}

function listCollections(
  schema: typeof ListCollectionsInputSchema,
  rawInput: unknown,
  ctx: McpDispatchContext
): ToolResult {
  const parsed = parse(schema, rawInput);
  if (!parsed.ok) return parsed;

  const visible = ctx.collections.filter((c) => canRead(ctx.consent, c.id));
  const summaries = visible.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description ?? '',
    requestCount: countRequests(c.items),
    executable: canExecute(ctx.consent, c.id),
  }));
  return { ok: true, data: { collections: summaries } };
}

function listRequests(
  schema: typeof ListRequestsInputSchema,
  rawInput: unknown,
  ctx: McpDispatchContext
): ToolResult {
  const parsed = parse(schema, rawInput);
  if (!parsed.ok) return parsed;

  const collection = ctx.collections.find((c) => c.id === parsed.data.collectionId);
  if (!collection) {
    return { ok: false, error: `Collection not found: ${parsed.data.collectionId}` };
  }
  if (!canRead(ctx.consent, collection.id)) {
    return {
      ok: false,
      error:
        'This collection is hidden from MCP agents. Enable it in Settings > MCP Server > Per-collection consent.',
    };
  }

  let items = collection.items;
  if (parsed.data.folderPath) {
    const segments = parsed.data.folderPath.split('/').filter((s) => s.length > 0);
    for (const seg of segments) {
      const next = items.find((it) => it.type === 'folder' && it.name === seg);
      if (!next || !next.items) {
        return { ok: false, error: `Folder path not found: ${parsed.data.folderPath}` };
      }
      items = next.items;
    }
  }

  const flat = flattenRequests(items, parsed.data.folderPath ?? '');
  const summaries = flat.map((entry) => {
    const req = entry.item.request;
    return {
      id: entry.item.id,
      name: entry.item.name,
      path: entry.path,
      type: req?.type ?? 'unknown',
      method: req && req.type === 'http' ? (req as HttpRequest).method : undefined,
      url: req && 'url' in req ? (req as { url?: string }).url : undefined,
      // Auth descriptor type only — not the credentials.
      authType: req && 'auth' in req ? (req as { auth?: { type?: string } }).auth?.type : 'none',
    };
  });
  return { ok: true, data: { requests: summaries } };
}

function getHistory(
  schema: typeof GetHistoryInputSchema,
  rawInput: unknown,
  ctx: McpDispatchContext
): ToolResult {
  const parsed = parse(schema, rawInput);
  if (!parsed.ok) return parsed;

  // History contains URLs, status codes, and timing for every past
  // request — including production traffic. Gate the entire surface
  // behind an explicit user opt-in.
  if (!canReadHistory(ctx.consent)) {
    return {
      ok: false,
      error:
        'Request history is hidden from MCP agents. Enable it in Settings > MCP Server > History.',
    };
  }

  const limit = parsed.data.limit ?? 50;
  const filter = parsed.data.filter?.toLowerCase();
  const entries = ctx.history
    .filter((entry) => {
      if (!filter) return true;
      const url = 'url' in entry.request ? entry.request.url : '';
      return (
        url.toLowerCase().includes(filter) || entry.request.name.toLowerCase().includes(filter)
      );
    })
    .slice(0, limit)
    .map((entry) => {
      const url = 'url' in entry.request ? entry.request.url : '';
      const method = entry.request.type === 'http' ? entry.request.method : undefined;
      return {
        id: entry.id,
        name: entry.request.name,
        type: entry.request.type,
        method,
        url,
        status: entry.response?.status,
        statusText: entry.response?.statusText,
        timestamp: entry.timestamp,
        duration: entry.response?.time,
      };
    });
  return { ok: true, data: { entries } };
}

function getEnvironment(
  schema: typeof GetEnvironmentInputSchema,
  rawInput: unknown,
  ctx: McpDispatchContext
): ToolResult {
  const parsed = parse(schema, rawInput);
  if (!parsed.ok) return parsed;

  const env = ctx.environments.find((e) => e.id === parsed.data.id);
  if (!env) {
    return { ok: false, error: `Environment not found: ${parsed.data.id}` };
  }
  // Environments may hold prod base URLs, region/service identifiers,
  // and secret-flagged variables. Refuse to read anything — including
  // the environment's name — unless the user has opted this one in.
  if (!canReadEnvironment(ctx.consent, env.id)) {
    return {
      ok: false,
      error:
        'This environment is hidden from MCP agents. Enable it in Settings > MCP Server > Per-environment consent.',
    };
  }
  return {
    ok: true,
    data: {
      id: env.id,
      name: env.name,
      variables: redactEnvironmentVariables(env.variables ?? []),
    },
  };
}

function listEnvironments(
  schema: typeof ListEnvironmentsInputSchema,
  rawInput: unknown,
  ctx: McpDispatchContext
): ToolResult {
  const parsed = parse(schema, rawInput);
  if (!parsed.ok) return parsed;
  // Only surface environments the user has opted in. Hidden environments
  // are filtered out entirely — the agent can't discover their existence.
  const visible = ctx.environments.filter((e) => canReadEnvironment(ctx.consent, e.id));
  return {
    ok: true,
    data: {
      environments: visible.map((e) => ({
        id: e.id,
        name: e.name,
        variableCount: (e.variables ?? []).filter((v) => v.enabled !== false).length,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countRequests(items: CollectionItem[]): number {
  let n = 0;
  for (const it of items) {
    if (it.type === 'request') n += 1;
    else if (it.type === 'folder' && it.items) n += countRequests(it.items);
  }
  return n;
}

function flattenRequests(
  items: CollectionItem[],
  basePath: string
): Array<{ item: CollectionItem; path: string }> {
  const out: Array<{ item: CollectionItem; path: string }> = [];
  for (const it of items) {
    const path = basePath ? `${basePath}/${it.name}` : it.name;
    if (it.type === 'request') {
      out.push({ item: it, path });
    } else if (it.type === 'folder' && it.items) {
      out.push(...flattenRequests(it.items, path));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result post-processing
// ---------------------------------------------------------------------------

/**
 * Apply secret-deep redaction to the final tool result. Belt-and-braces:
 * the individual tool impls already redact, but this catches any new tool
 * (or future modification to an existing tool) that forgets.
 */
export function postProcessResult(result: ToolResult): ToolResult {
  if (!result.ok) return result;
  return { ok: true, data: redactSecretsDeep(result.data) };
}
