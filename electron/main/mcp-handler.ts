import { ipcMain } from 'electron';
import { createKeyedRateLimiter, rateLimited } from './ipc-rate-limiter';
import { emitTo } from './ipc-utils';
import { bindRendererCleanup, disposeByOwner } from './connection-cleanup';
import { assertUrlHostnameSafe } from './dns-guard';
import {
  McpConnectSchema,
  McpRequestSchema,
  McpDisconnectSchema,
  validateIpcInput,
  createValidatedHandler,
} from './ipc-validators';
import { SseParser, type ParsedSseEvent } from './sse-parser';
import { IPC, EVENT_PREFIX, eventChannel } from '../shared/channels';
import { followRedirects, RedirectPolicyError } from '@shared/protocol/redirect-follower';
import type { Fetcher, FetcherResponse } from '@shared/protocol/types';

/**
 * MCP IPC handler. Implements the client side of two HTTP-based MCP transports:
 *
 * - **streamable-http**: a single endpoint accepts JSON-RPC POSTs. The response
 *   is either a JSON body (for one-shot calls) or an SSE stream (for calls that
 *   stream notifications). We branch on Content-Type.
 *
 * - **http-sse** (legacy): the client opens a persistent SSE GET stream to receive
 *   server-pushed messages, and posts JSON-RPC requests to a separate endpoint.
 *   Per spec the server advertises the POST endpoint via an `endpoint` SSE event.
 */

export const mcpRateLimiter = createKeyedRateLimiter(60, 60_000);
const MAX_CONCURRENT_MCP = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface SessionBase {
  connectionId: string;
  url: string;
  webContentsId: number;
  headers: Record<string, string>;
  createdAt: number;
}

interface StreamableHttpSession extends SessionBase {
  transport: 'streamable-http';
  /** Some MCP servers issue an Mcp-Session-Id on initialize; remember and echo it. */
  sessionId?: string;
}

interface HttpSseSession extends SessionBase {
  transport: 'http-sse';
  abortController: AbortController;
  /** POST endpoint advertised by the server's `endpoint` SSE event */
  postEndpoint?: string;
  /** Pending JSON-RPC requests awaiting matching response by id */
  pending: Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

type Session = StreamableHttpSession | HttpSseSession;

const sessions = new Map<string, Session>();

function disposeSession(s: Session): void {
  if (s.transport === 'http-sse') {
    s.abortController.abort();
    for (const p of s.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    s.pending.clear();
  }
}

function teardownSession(connectionId: string): void {
  const s = sessions.get(connectionId);
  if (!s) return;
  disposeSession(s);
  sessions.delete(connectionId);
}

async function readSseStream(
  session: HttpSseSession,
  body: ReadableStream<Uint8Array> | null
): Promise<void> {
  if (!body) {
    emitTo(session.webContentsId, eventChannel(EVENT_PREFIX.mcp.error, session.connectionId), { message: 'No SSE body' });
    teardownSession(session.connectionId);
    return;
  }
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const reader = body.getReader();

  const onEvent = (e: ParsedSseEvent) => {
    // Per the http-sse transport, the first event is `endpoint` with the POST URL.
    if (e.event === 'endpoint') {
      // The data is the absolute or relative URL to POST JSON-RPC requests to.
      try {
        session.postEndpoint = new URL(e.data, session.url).toString();
      } catch {
        session.postEndpoint = e.data;
      }
      return;
    }
    if (e.event === 'message' || e.event === 'notification') {
      try {
        const parsed = JSON.parse(e.data) as {
          id?: string | number;
          method?: string;
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        };
        if (parsed.id !== undefined && session.pending.has(parsed.id)) {
          const pending = session.pending.get(parsed.id)!;
          clearTimeout(pending.timer);
          session.pending.delete(parsed.id);
          if (parsed.error) {
            pending.reject(new Error(`JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`));
          } else {
            pending.resolve(parsed.result);
          }
          return;
        }
        // Unmatched message — treat as a server-initiated notification
        emitTo(session.webContentsId, eventChannel(EVENT_PREFIX.mcp.notification, session.connectionId), parsed);
      } catch (err) {
        emitTo(session.webContentsId, eventChannel(EVENT_PREFIX.mcp.error, session.connectionId), {
          message: `Failed to parse SSE message: ${err instanceof Error ? err.message : 'unknown'}`,
        });
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }), onEvent);
    }
    parser.feed(decoder.decode(), onEvent);
  } catch (err) {
    if (!session.abortController.signal.aborted) {
      emitTo(session.webContentsId, eventChannel(EVENT_PREFIX.mcp.error, session.connectionId), {
        message: err instanceof Error ? err.message : 'SSE read error',
      });
    }
  } finally {
    if (sessions.get(session.connectionId) === session) {
      emitTo(session.webContentsId, eventChannel(EVENT_PREFIX.mcp.close, session.connectionId), { reason: 'stream ended' });
      teardownSession(session.connectionId);
    }
  }
}

/** Drain a fetch response that's either application/json or text/event-stream
 *  and produce a single JSON-RPC result. Used by the streamable-http transport. */
async function readStreamableHttpResponse(
  response: globalThis.Response,
  expectedId: string | number
): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const body = await response.json() as { id?: string | number; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    return body.error ? { error: body.error } : { result: body.result };
  }
  if (ct.includes('text/event-stream')) {
    if (!response.body) throw new Error('SSE response has no body');
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const reader = response.body.getReader();
    let resolved: { result?: unknown; error?: { code: number; message: string; data?: unknown } } | undefined;
    const onEvent = (e: ParsedSseEvent) => {
      if (resolved) return;
      try {
        const parsed = JSON.parse(e.data) as { id?: string | number; result?: unknown; error?: { code: number; message: string; data?: unknown } };
        if (parsed.id === expectedId) {
          resolved = parsed.error ? { error: parsed.error } : { result: parsed.result };
        }
      } catch {
        /* skip non-JSON events */
      }
    };
    try {
      while (!resolved) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }), onEvent);
      }
      parser.feed(decoder.decode(), onEvent);
      if (!resolved) throw new Error('SSE stream ended without matching response');
      return resolved;
    } finally {
      // Cancel as soon as the matching reply is found (or the stream errors) so we
      // don't keep draining bytes from the upstream after we have what we need.
      try { await reader.cancel(); } catch { /* already done */ }
    }
  }
  throw new Error(`Unsupported MCP response Content-Type: ${ct || '(none)'}`);
}

export function registerMcpHandlerIPC(): void {
  ipcMain.handle(IPC.mcp.connect, async (event, rawConfig: unknown) => {
    const config = validateIpcInput(McpConnectSchema, rawConfig, IPC.mcp.connect);
    const webContentsId = event.sender.id;

    if (!mcpRateLimiter.check(webContentsId)) {
      return { success: false, error: 'Rate limit exceeded.' };
    }
    if (sessions.size >= MAX_CONCURRENT_MCP) {
      return { success: false, error: 'Too many open MCP connections.' };
    }

    teardownSession(config.connectionId);

    try {
      await assertUrlHostnameSafe(config.url, { allowLocalhost: true });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'URL rejected by SSRF policy' };
    }

    bindRendererCleanup(sessions, event.sender, (deadId) => {
      disposeByOwner(sessions, deadId, disposeSession);
    });

    if (config.transport === 'streamable-http') {
      const session: StreamableHttpSession = {
        connectionId: config.connectionId,
        url: config.url,
        webContentsId,
        headers: config.headers ?? {},
        createdAt: Date.now(),
        transport: 'streamable-http',
      };
      sessions.set(config.connectionId, session);
      emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.open, config.connectionId));
      return { success: true };
    }

    // http-sse: open the persistent SSE stream and wait for the `endpoint` event.
    const abortController = new AbortController();
    const session: HttpSseSession = {
      connectionId: config.connectionId,
      url: config.url,
      webContentsId,
      headers: config.headers ?? {},
      createdAt: Date.now(),
      transport: 'http-sse',
      abortController,
      pending: new Map(),
    };
    sessions.set(config.connectionId, session);

    // Adapter for followRedirects: native fetch with `redirect: 'manual'` so
    // we validate every redirect target (preventing SSRF via attacker-controlled
    // `Location: http://169.254.169.254/...` headers).
    const mcpFetcher: Fetcher = async (req) => {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        redirect: 'manual',
      });
      const fetcherResponse: FetcherResponse = {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        text: () => res.text(),
        contentLengthHeader: res.headers.get('content-length'),
        body: res.body,
      };
      return fetcherResponse;
    };

    try {
      const response = await followRedirects(
        {
          url: config.url,
          method: 'GET',
          headers: { Accept: 'text/event-stream', ...session.headers },
          body: undefined,
          signal: abortController.signal,
        },
        mcpFetcher,
        // MCP handler is desktop-only; permit localhost (developers commonly
        // run MCP servers locally).
        { allowLocalhost: true }
      );
      if (response.status < 200 || response.status >= 300) {
        teardownSession(config.connectionId);
        return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
      }
      emitTo(webContentsId, eventChannel(EVENT_PREFIX.mcp.open, config.connectionId));
      void readSseStream(session, response.body ?? null);
      return { success: true };
    } catch (err) {
      teardownSession(config.connectionId);
      if (err instanceof RedirectPolicyError) {
        return { success: false, error: err.message };
      }
      return { success: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  });

  ipcMain.handle(
    IPC.mcp.request,
    rateLimited(
      mcpRateLimiter,
      createValidatedHandler(IPC.mcp.request, McpRequestSchema, async (config) => {
        const session = sessions.get(config.connectionId);
        if (!session) {
          return { success: false, error: 'Not connected' };
        }

        const requestId = config.requestId ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timeoutMs = config.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method: config.method,
          ...(config.params !== undefined ? { params: config.params } : {}),
        });

        try {
          if (session.transport === 'streamable-http') {
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              ...session.headers,
            };
            if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;

            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), timeoutMs);
            try {
              const response = await fetch(session.url, {
                method: 'POST',
                headers,
                body,
                signal: ctl.signal,
              });
              const advertised = response.headers.get('mcp-session-id');
              if (advertised) session.sessionId = advertised;

              if (!response.ok) {
                return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
              }
              const out = await readStreamableHttpResponse(response, requestId);
              return out.error
                ? { success: false, jsonRpcError: out.error }
                : { success: true, result: out.result };
            } finally {
              clearTimeout(timer);
            }
          }

          // http-sse: POST to the advertised endpoint, await response on the SSE stream.
          if (!session.postEndpoint) {
            return { success: false, error: 'MCP server did not advertise a POST endpoint' };
          }
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...session.headers,
          };

          const pendingPromise = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
              session.pending.delete(requestId);
              reject(new Error(`MCP request timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            session.pending.set(requestId, { resolve, reject, timer });
          });

          const postResponse = await fetch(session.postEndpoint, {
            method: 'POST',
            headers,
            body,
          });
          if (!postResponse.ok) {
            const p = session.pending.get(requestId);
            if (p) {
              clearTimeout(p.timer);
              session.pending.delete(requestId);
            }
            return { success: false, error: `HTTP ${postResponse.status} ${postResponse.statusText}` };
          }

          const result = await pendingPromise;
          return { success: true, result };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'MCP request failed' };
        }
      })
    )
  );

  ipcMain.handle(
    IPC.mcp.disconnect,
    createValidatedHandler(IPC.mcp.disconnect, McpDisconnectSchema, async (config) => {
      teardownSession(config.connectionId);
      return { success: true };
    })
  );
}

export function stopMcpCleanup(): void {
  for (const id of [...sessions.keys()]) teardownSession(id);
}
