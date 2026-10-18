/**
 * MCP protocol-version constants shared by every Restura MCP client.
 *
 * Desktop and the CLI use the official SDK (`@modelcontextprotocol/client`),
 * whose `initialize` handshake offers the SDK's `LATEST_PROTOCOL_VERSION`.
 * The web / self-host client hand-rolls JSON-RPC through `/api/mcp`, so it
 * offers this constant instead. `mcp-version.test.ts` pins the two together:
 * bumping the SDK without bumping this constant fails the suite, which keeps
 * the web `initialize` offer in lock-step with desktop.
 *
 * The SDK may additionally negotiate a newer *stateless* revision via
 * `server/discover` (desktop `versionNegotiation: auto`). The web client does
 * not implement that revision, so it only offers the newest version that the
 * `initialize` handshake supports.
 */
export const MCP_LATEST_PROTOCOL_VERSION = '2025-11-25';

/** Versions the hand-rolled web client understands, newest first. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  MCP_LATEST_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** HTTP header the Streamable HTTP transport requires after initialization. */
export const MCP_PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';

/** HTTP header carrying the server-assigned session id. */
export const MCP_SESSION_ID_HEADER = 'Mcp-Session-Id';

/**
 * Protocol versions are short date-shaped tokens (`YYYY-MM-DD`). Anything that
 * is not a short token is refused before it reaches a header, so a hostile or
 * garbled `initialize` result cannot smuggle arbitrary bytes into an outbound
 * request header.
 */
const PROTOCOL_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

export function isValidMcpProtocolVersion(value: unknown): value is string {
  return typeof value === 'string' && PROTOCOL_VERSION_RE.test(value);
}

/** JSON-RPC notifications carry no `id` and never receive a response. */
export function isMcpNotificationMethod(method: string): boolean {
  return method.startsWith('notifications/');
}
