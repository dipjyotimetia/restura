/**
 * `Restura --mcp-server` — the stdio entry for agents (ADR 0041).
 *
 * Claude Code, Claude Desktop, Codex and Cursor launch MCP servers as stdio
 * subprocesses. The real server lives inside the running desktop app (it owns
 * the data), so this process is a thin shim: it exposes the same tool
 * catalogue over stdio and relays every call to the app's loopback control
 * server, authenticating with the token from the 0600 handshake file under
 * userData. No token ever has to be written into an agent's config file.
 *
 * The shim never caches user data and never decides policy; when the app is
 * not running (or the server is off) each call fails with a clear message so
 * the agent can tell the user what to do. It reconnects on the next call, so
 * the user can start Restura after the agent.
 *
 * Logs go to stderr — the MCP SDK owns stdout for JSON-RPC.
 */

import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { HandshakeFile, ToolCallClient } from '@shared/mcp-server/control-bridge';
import { createLogger } from '@shared/runtime/logger';
import { isProcessAlive, readHandshake } from './mcp-control-protocol';
import {
  type CallToolContent,
  type ControlServerIdentity,
  type ControlToolCall,
  createControlMcpServer,
} from './mcp-control-server';

const log = createLogger('mcp-server');

export const APP_NOT_RUNNING_MESSAGE =
  'Restura is not running, or its MCP server is turned off. Ask the user to open Restura and turn on Settings > MCP Server, then retry.';

export interface McpServerHandle {
  /** Stop the server and free the transport. Idempotent. */
  stop: () => Promise<void>;
}

/** One connection to the running app's control server. */
export interface RemoteControlSession {
  callTool(call: ControlToolCall): Promise<CallToolContent>;
  close(): Promise<void>;
}

export type RemoteSessionFactory = (
  handshake: HandshakeFile,
  client: ToolCallClient | undefined
) => Promise<RemoteControlSession>;

function isCallToolContent(value: unknown): value is CallToolContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/** Default factory: an SDK client over streamable HTTP to 127.0.0.1. */
export const connectRemoteSession: RemoteSessionFactory = async (handshake, client) => {
  const headers: Record<string, string> = { authorization: `Bearer ${handshake.token}` };
  if (client) {
    headers['x-restura-mcp-client'] =
      `${client.name}${client.version ? `/${client.version}` : ''} (stdio)`;
  }
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${handshake.port}/mcp`),
    { requestInit: { headers } }
  );
  const sdk = new Client({ name: 'restura-stdio-shim', version: '1.0.0' }, { capabilities: {} });
  await sdk.connect(transport);
  return {
    async callTool(call) {
      // Generous: the remote side may be waiting on the user's approval.
      const result: unknown = await sdk.callTool(
        { name: call.tool, arguments: call.input as Record<string, unknown> },
        { signal: call.signal, timeout: 11 * 60_000, resetTimeoutOnProgress: true }
      );
      if (!isCallToolContent(result)) {
        return {
          content: [{ type: 'text', text: 'Restura returned an unexpected result.' }],
          isError: true,
        };
      }
      return result;
    },
    close: () => sdk.close(),
  };
};

export interface StdioShimOptions {
  identity: ControlServerIdentity;
  /** userData directory holding the handshake file. */
  userDataDir: string;
  /** Test seam. */
  connect?: RemoteSessionFactory;
  /** Test seam. */
  isAlive?: (pid: number) => boolean;
}

/**
 * True only when the failure proves the request never reached the app
 * (connection refused while dialling). Anything else — a reset mid-request, a
 * timeout — is ambiguous: the call may have run, so it must not be retried.
 */
export function isConnectionRefused(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if ((current as NodeJS.ErrnoException).code === 'ECONNREFUSED') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function errorContent(text: string): CallToolContent {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * The relay behind every shim tool: resolves the running app from the
 * handshake file (fresh on each call, so restarts and token rotation are
 * picked up) and reuses one session per (port, token). A call is retried
 * once, on a fresh session, only when the failure proves it was never
 * delivered — tool calls such as send_request are not idempotent.
 */
export function createShimRelay(options: StdioShimOptions) {
  const connect = options.connect ?? connectRemoteSession;
  const isAlive = options.isAlive ?? isProcessAlive;
  let session: { key: string; promise: Promise<RemoteControlSession> } | null = null;

  const notRunning = (): CallToolContent => errorContent(APP_NOT_RUNNING_MESSAGE);

  async function dropSession(): Promise<void> {
    const current = session;
    session = null;
    if (current) await current.promise.then((s) => s.close()).catch(() => undefined);
  }

  async function relay(call: ControlToolCall, client: ToolCallClient | undefined) {
    const handshake = await readHandshake(options.userDataDir);
    if (!handshake || !handshake.running || !isAlive(handshake.pid)) {
      await dropSession();
      return notRunning();
    }
    const key = `${handshake.port}:${handshake.token}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!session || session.key !== key) {
        await dropSession();
        session = { key, promise: connect(handshake, client) };
      }
      let remote: RemoteControlSession;
      try {
        remote = await session.promise;
      } catch (err) {
        // Connecting failed: nothing was sent, so a retry is safe.
        log.warn('could not connect to Restura', { attempt, message: String(err) });
        await dropSession();
        continue;
      }
      try {
        return await remote.callTool(call);
      } catch (err) {
        if (call.signal.aborted) throw err;
        if (err instanceof ProtocolError) {
          // The app answered with a JSON-RPC error; the session is fine.
          return errorContent(err.message.replace(/^MCP error -?\d+:\s*/, ''));
        }
        await dropSession();
        if (isConnectionRefused(err)) continue;
        log.warn('relay to Restura failed', { message: String(err) });
        return errorContent(
          'Lost the connection to Restura while the tool was running; it may or may not have completed. Check Restura before retrying.'
        );
      }
    }
    return notRunning();
  }

  return { relay, close: dropSession };
}

/** Build one stdio-facing server instance over a relay. */
export function createShimServer(
  identity: ControlServerIdentity,
  relay: (call: ControlToolCall, client: ToolCallClient | undefined) => Promise<CallToolContent>
): McpServer {
  let server: McpServer | undefined;
  const clientOf = (): ToolCallClient | undefined => {
    const info = server?.server.getClientVersion();
    return info ? { name: info.name, version: info.version } : undefined;
  };
  server = createControlMcpServer(identity, (call) => relay(call, clientOf()));
  return server;
}

export function startStdioMcpServer(options: StdioShimOptions): McpServerHandle {
  const relay = createShimRelay(options);
  const handle = serveStdio(() => createShimServer(options.identity, relay.relay), {
    legacy: 'serve',
    onerror: (error) => {
      log.error('stdio server error', { message: error.message });
    },
  });

  return {
    stop: async () => {
      await relay.close();
      await handle.close();
    },
  };
}
