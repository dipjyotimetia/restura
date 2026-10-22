/**
 * Classification of an MCP JSON-RPC outcome. MCP reports failures at two
 * distinct layers (2025-06-18, Server > Tools > Error Handling):
 *  - protocol error: transport/JSON-RPC failure (`error` member, HTTP failure)
 *  - tool error: a *successful* JSON-RPC response whose `CallToolResult` has
 *    `isError: true`
 * Shared by the renderer result panel and the CLI so every consumer draws the
 * same line.
 */
export type McpOutcomeKind = 'ok' | 'protocol-error' | 'tool-error';

/** True when `result` is a CallToolResult flagged `isError: true`. */
export function isMcpToolError(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

export function classifyMcpOutcome(outcome: {
  error?: unknown;
  jsonRpcError?: unknown;
  result?: unknown;
}): McpOutcomeKind {
  if (outcome.error !== undefined || outcome.jsonRpcError !== undefined) return 'protocol-error';
  return isMcpToolError(outcome.result) ? 'tool-error' : 'ok';
}

/** Best-effort one-line text of a tool error's `content` (for messages). */
export function mcpToolErrorText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return 'tool reported isError';
  const text = content
    .map((c) =>
      c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
        ? String((c as { text?: unknown }).text ?? '')
        : ''
    )
    .filter(Boolean)
    .join(' ')
    .trim();
  return text || 'tool reported isError';
}
