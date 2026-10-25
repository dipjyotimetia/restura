// Capability rows: MCP client.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const MCP_CAPABILITIES = {
  'mcp.basic': {
    label: 'MCP streamable-http / http-sse',
    web: true,
    desktop: true,
    notes:
      'http-sse transport is desktop-only; web supports streamable-http and rejects http-sse at connect time. Web runs the initialize/initialized handshake, MCP-Protocol-Version, DELETE on disconnect and one re-initialize on 404 session expiry, and surfaces server messages interleaved in a reply; it has no standalone GET listening stream and no Last-Event-ID resumption (desktop only)',
  },
  'mcp.clientRequests': {
    label: 'MCP elicitation, sampling and roots (incl. 2026-07-28 input_required)',
    web: false,
    desktop: true,
    notes:
      'Server→client requests need a persistent channel back to the client; the web Worker proxy is request/response only. Desktop: form-mode elicitation (URL mode not advertised), sampling with per-request human approval (manual text or an AI-assistant provider draft), per-connection file:// roots with list_changed',
  },
  'mcp.serverNotifications': {
    label: 'MCP server notifications (progress, logging, list_changed, resources/updated)',
    web: false,
    desktop: true,
    notes:
      'Desktop streams server→client events over IPC into the Events pane and re-discovers on list_changed; on 2026-07-28 servers list_changed rides an auto-opened subscriptions/listen stream. The web Worker proxy is request/response only, so there is no server→client channel',
  },
  'mcp.resourceSubscriptions': {
    label: 'MCP resource subscriptions',
    web: false,
    desktop: true,
    notes:
      'Subscribe/Unsubscribe toggle when the server advertises resources.subscribe; 2025-era servers use resources/subscribe, 2026-07-28 servers a per-resource subscriptions/listen stream (max 32 per connection). Needs the desktop server→client channel',
  },
  'mcp.auth': {
    label: 'MCP connection auth (Bearer / API-key header)',
    web: true,
    desktop: true,
    notes:
      'Desktop can store the credential as an OS-keychain or external SecretRef handle, resolved in the main process at connect time; web is inline-only and never persists the request’s own MCP credentials to IndexedDB (re-enter after reload). SecretRef-backed {{secret variables}} in MCP auth/headers are not resolved yet on either platform',
  },
  'mcp.oauth': {
    label: 'MCP OAuth 2.1 sign-in (PKCE, PRM discovery, dynamic registration)',
    web: false,
    desktop: true,
    notes:
      'Desktop runs the flow in the main process: system browser + 127.0.0.1 loopback redirect, tokens kept only in the OS-keychain-encrypted secret store and refreshed automatically (ADR 0031). Web/self-host and the CLI do not run the browser sign-in — paste an access token as Bearer auth instead',
  },
  'mcp.stdio': {
    label: 'MCP stdio transport (local server process)',
    web: false,
    desktop: true,
    notes:
      'Desktop main process spawns the command without a shell after a per-launch native consent prompt; the child gets an allowlisted environment, and is killed on disconnect/quit. Web and the CLI never spawn processes',
  },
  'mcp.configImport': {
    label: 'Import MCP servers from Claude Desktop / Cursor / VS Code configs',
    web: true,
    desktop: true,
    notes:
      'Desktop reads the well-known config locations or a native file picker in the main process, stores credential-named stdio env values as secret handles, and imported stdio servers still need the per-launch consent prompt. Web accepts pasted or uploaded JSON (1 MB cap) and imports remote (HTTP) servers only; stdio entries are shown as desktop-only',
  },
  'mcp.conformance': {
    label: 'MCP era/conformance report',
    web: true,
    desktop: true,
    notes:
      'Desktop connects in both protocol eras (legacy initialize and pinned modern 2026-07-28) and diffs them. Web runs the legacy era only: /api/mcp is a stateless JSON-RPC proxy with no era negotiation, so the modern era needs the desktop app or `restura mcp conformance`',
  },
} as const satisfies Record<string, CapabilityRow>;
