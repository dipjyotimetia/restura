import { type JsonRpcError, jsonRpcErrorToMessage } from './mcp-proxy';

/**
 * Runner-side contract for a saved MCP request (#901): one JSON-RPC operation
 * (`defaultMethod` + `defaultParams`) executed by the in-app collection runner
 * and by `restura run`. Both harnesses build the response the same way here so
 * a test script behaves identically on desktop, web and CLI.
 *
 * The response body is the JSON-RPC reply envelope (without the transport id):
 *
 *   { "jsonrpc": "2.0", "result": { ...,  "isError": true? } }   — reply
 *   { "jsonrpc": "2.0", "error": { "code", "message", "data"? } } — JSON-RPC error
 *
 * so `rs.response.json().result.isError` asserts a tool-level failure and
 * `rs.response.json().error` a protocol-level one — never ambiguous.
 */

/**
 * - `result`: a successful reply.
 * - `tool-error`: a successful reply whose result carries `isError: true`
 *   (MCP `tools/call` reports tool failures in-band).
 * - `jsonrpc-error`: the server answered with a JSON-RPC `error` object.
 *
 * Transport failures (connect/HTTP/timeout) are not outcomes — they throw.
 */
export type McpRunOutcome = 'result' | 'tool-error' | 'jsonrpc-error';

export interface McpRunReply {
  outcome: McpRunOutcome;
  /** JSON envelope handed to test scripts as the response body. */
  body: string;
  /** Human-readable status line; for failures also the default error message. */
  statusText: string;
}

export type McpRunReplyInput = { result: unknown } | { error: JsonRpcError };

function isToolError(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

/**
 * Same wording as the CLI/registry tool-error path (#868):
 * `MCP tool error (isError: true): <first text block>`.
 */
export function mcpToolErrorMessage(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  const text = Array.isArray(content)
    ? content
        .filter((b): b is { type: 'text'; text: string } => {
          const block = b as { type?: unknown; text?: unknown } | null;
          return block?.type === 'text' && typeof block.text === 'string';
        })
        .map((b) => b.text)
        .join('\n')
    : '';
  return text ? `MCP tool error (isError: true): ${text}` : 'MCP tool error (isError: true)';
}

export function buildMcpRunReply(input: McpRunReplyInput): McpRunReply {
  if ('error' in input) {
    return {
      outcome: 'jsonrpc-error',
      body: JSON.stringify({ jsonrpc: '2.0', error: input.error }, null, 2),
      statusText: jsonRpcErrorToMessage(input.error),
    };
  }
  const toolError = isToolError(input.result);
  return {
    outcome: toolError ? 'tool-error' : 'result',
    // `result` is required on a JSON-RPC reply; normalise a missing one to null.
    body: JSON.stringify({ jsonrpc: '2.0', result: input.result ?? null }, null, 2),
    statusText: toolError ? mcpToolErrorMessage(input.result) : 'OK',
  };
}

/** Actionable message for a saved MCP request with no operation (#877). */
export function mcpMissingMethodMessage(requestName: string): string {
  return (
    `No MCP method configured for "${requestName}". Set defaultMethod (e.g. "tools/call", ` +
    `"resources/read", "prompts/get") and defaultParams (e.g. {"name":"<tool>","arguments":{}}) ` +
    'on the request — open it in Restura, build the operation, and save it to the collection again.'
  );
}

/**
 * Parse the (already variable-resolved) `defaultParams` JSON. Blank means no
 * params. JSON-RPC params must be structured, so anything else is an error
 * rather than being sent as a bare string.
 */
export function parseMcpRunParams(
  raw: string | undefined
): { ok: true; params: unknown } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, params: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `MCP params are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'MCP params must be a JSON object or array' };
  }
  return { ok: true, params: parsed };
}

/**
 * Stable key for pooling one MCP session per server within a run: the same
 * resolved url + transport + headers share a session (initialize once).
 */
export function mcpSessionKey(
  url: string,
  transport: string,
  headers: Record<string, string>
): string {
  const sorted = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v])
    .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
  return JSON.stringify([url, transport, sorted]);
}
