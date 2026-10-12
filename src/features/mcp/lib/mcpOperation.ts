import type { McpRequest } from '@/types';

/**
 * The single MCP operation a saved request represents. Persisted in the
 * existing `McpRequest.defaultMethod` + `defaultParams` (JSON) fields so the
 * CLI runner and OpenCollection export see exactly what the builder selected:
 *
 *   tools/call     → { name, arguments? }
 *   prompts/get    → { name, arguments? }
 *   resources/read → { uri }
 *
 * `arguments` is absent (not `{}`) right after a fresh selection, which tells
 * the invoke form to seed from the tool's schema template instead.
 */
export type McpOperation =
  | { kind: 'tool'; name: string; arguments?: Record<string, unknown> }
  | { kind: 'prompt'; name: string; arguments?: Record<string, string> }
  | { kind: 'resource'; uri: string };

const METHOD_BY_KIND = {
  tool: 'tools/call',
  prompt: 'prompts/get',
  resource: 'resources/read',
} as const satisfies Record<McpOperation['kind'], string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === 'string' ? entry : JSON.stringify(entry),
    ])
  );
}

/** Read the operation back out of a request; null for none / unrecognised methods. */
export function parseMcpOperation(
  request: Pick<McpRequest, 'defaultMethod' | 'defaultParams'>
): McpOperation | null {
  const method = request.defaultMethod;
  if (!method) return null;
  let params: unknown = {};
  if (request.defaultParams?.trim()) {
    try {
      params = JSON.parse(request.defaultParams);
    } catch {
      return null;
    }
  }
  if (!isRecord(params)) return null;
  const args = isRecord(params.arguments) ? params.arguments : undefined;

  if (method === METHOD_BY_KIND.tool && typeof params.name === 'string') {
    return { kind: 'tool', name: params.name, ...(args ? { arguments: args } : {}) };
  }
  if (method === METHOD_BY_KIND.prompt && typeof params.name === 'string') {
    return {
      kind: 'prompt',
      name: params.name,
      ...(args ? { arguments: stringRecord(args) } : {}),
    };
  }
  if (method === METHOD_BY_KIND.resource && typeof params.uri === 'string') {
    return { kind: 'resource', uri: params.uri };
  }
  return null;
}

/** Fields to write onto the tab's `McpRequest` for `operation`. */
export function serializeMcpOperation(
  operation: McpOperation
): Required<Pick<McpRequest, 'defaultMethod' | 'defaultParams'>> {
  const params =
    operation.kind === 'resource'
      ? { uri: operation.uri }
      : {
          name: operation.name,
          ...(operation.arguments ? { arguments: operation.arguments } : {}),
        };
  return {
    defaultMethod: METHOD_BY_KIND[operation.kind],
    defaultParams: JSON.stringify(params, null, 2),
  };
}
