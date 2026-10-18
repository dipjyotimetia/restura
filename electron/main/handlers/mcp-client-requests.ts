import { randomUUID } from 'node:crypto';
import { validateElicitationContent } from '@shared/protocol/mcp-elicitation';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain, type WebContents } from 'electron';
import { EVENT_PREFIX, eventChannel, IPC } from '../../shared/channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { emitTo, errorMessage } from '../ipc/ipc-utils';
import {
  createValidatedEventHandler,
  type McpClientResponse,
  McpClientResponseSchema,
  type McpRoot,
  McpSetRootsSchema,
} from '../ipc/ipc-validators';
import { ownerScopedKey } from '../ipc/stream-registry';
import type { McpSdkClientRequestHandlers } from './mcp-sdk-client';

/**
 * Server→client MCP requests (#860): `elicitation/create`, `sampling/createMessage`
 * and `roots/list`, plus their 2026-07-28 multi-round `input_required`
 * equivalents (the v2 SDK fulfils embedded input requests through the same
 * registered handlers).
 *
 * Elicitation and sampling need a human, so each request is forwarded to the
 * OWNING renderer on `mcp:client-request:<connectionId>` and parked until the
 * renderer answers on the `mcp:client-response` invoke channel. A parked
 * request settles exactly once: on the owner's answer, on timeout, when the
 * server cancels it (SDK abort signal), or when the connection is disposed
 * (disconnect, close, renderer destroyed). Every non-answer settlement emits
 * `mcp:client-request-cancelled:<connectionId>` so the renderer drops its
 * prompt. Sampling is never auto-approved: main only produces a
 * `CreateMessageResult` from an explicit renderer `approve`.
 *
 * Roots are answered from main without a round-trip: the renderer pushes the
 * per-connection list via `mcp:set-roots` (before connecting and on every edit)
 * and live sessions are sent `notifications/roots/list_changed`.
 */

const log = createLogger('mcp-client-requests');

/** Human-in-the-loop prompts get a generous, but bounded, answer window. */
export const MCP_CLIENT_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** A server cannot park more than this many prompts on one connection. */
export const MAX_PENDING_CLIENT_REQUESTS = 8;
/** Largest server request (serialised params) forwarded to the renderer. */
export const MAX_CLIENT_REQUEST_PARAMS_BYTES = 100_000;
/** Per-renderer IPC budgets: answers are human-paced; roots edits rarer still. */
export const mcpClientResponseRateLimiter = createKeyedRateLimiter(120, 60_000);
export const mcpSetRootsRateLimiter = createKeyedRateLimiter(20, 60_000);
/** Bound on distinct connection ids a single renderer may store roots for. */
const MAX_ROOT_ENTRIES_PER_OWNER = 64;

/** JSON-RPC error codes returned to the server. */
export const MCP_CLIENT_REQUEST_ERRORS = {
  /** Spec example code for a user-rejected sampling request. */
  userRejected: -1,
  /** Matches the SDK's RequestTimeout code. */
  timeout: -32001,
  invalidParams: -32602,
  internal: -32603,
} as const;

function serialisedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export type McpClientRequestKind = 'elicitation' | 'sampling';

/** Payload of `mcp:client-request:<connectionId>`. */
export interface McpClientRequestEvent {
  requestId: string;
  kind: McpClientRequestKind;
  params: unknown;
}

/** Payload of `mcp:client-request-cancelled:<connectionId>`. */
export interface McpClientRequestCancelledEvent {
  requestId: string;
  reason: 'timeout' | 'cancelled' | 'closed';
}

/** Error carrying a JSON-RPC code; the SDK serialises `code` verbatim into the error response. */
export class McpClientRequestError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = 'McpClientRequestError';
  }
}

interface PendingClientRequest {
  requestId: string;
  kind: McpClientRequestKind;
  params: unknown;
  bridge: McpClientRequestBridge;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  detachSignal: () => void;
}

interface StoredRoots {
  webContentsId: number;
  roots: McpRoot[];
}

const pending = new Map<string, PendingClientRequest>();
const rootsByOwner = new Map<string, StoredRoots>();
const liveBridges = new Map<string, Set<McpClientRequestBridge>>();

export interface McpRootsNotifier {
  sendRootsListChanged(): Promise<void>;
}

export interface McpClientRequestBridgeOptions {
  timeoutMs?: number;
}

/**
 * One bridge per MCP session attempt. Owner-scoped: it only ever emits to, and
 * accepts answers from, the renderer that opened the connection.
 */
export class McpClientRequestBridge implements McpSdkClientRequestHandlers {
  private client: McpRootsNotifier | undefined;
  private disposed = false;
  private readonly timeoutMs: number;
  readonly ownerKey: string;

  constructor(
    readonly connectionId: string,
    readonly webContentsId: number,
    options: McpClientRequestBridgeOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? MCP_CLIENT_REQUEST_TIMEOUT_MS;
    this.ownerKey = ownerScopedKey(connectionId, webContentsId);
    let bridges = liveBridges.get(this.ownerKey);
    if (!bridges) {
      bridges = new Set();
      liveBridges.set(this.ownerKey, bridges);
    }
    bridges.add(this);
  }

  /** The SDK client that roots list-changed notifications are sent through. */
  attachClient(client: McpRootsNotifier): void {
    if (!this.disposed) this.client = client;
  }

  elicit(params: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.forward('elicitation', params, signal);
  }

  createMessage(params: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.forward('sampling', params, signal);
  }

  listRoots(): { roots: McpRoot[] } {
    const stored = rootsByOwner.get(this.ownerKey);
    return { roots: stored ? stored.roots.map((root) => ({ ...root })) : [] };
  }

  /** Notify the server its roots changed. Best-effort: a closed peer is not an error. */
  async notifyRootsChanged(): Promise<boolean> {
    const client = this.client;
    if (this.disposed || !client) return false;
    try {
      await client.sendRootsListChanged();
      return true;
    } catch (err) {
      log.warn('roots list_changed failed', {
        connectionId: this.connectionId,
        error: errorMessage(err),
      });
      return false;
    }
  }

  /** Reject every parked request and detach. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.client = undefined;
    for (const entry of [...pending.values()]) {
      if (entry.bridge !== this) continue;
      settle(entry, 'closed');
      entry.reject(
        new McpClientRequestError(MCP_CLIENT_REQUEST_ERRORS.internal, 'MCP connection closed')
      );
    }
    const bridges = liveBridges.get(this.ownerKey);
    bridges?.delete(this);
    if (bridges?.size === 0) liveBridges.delete(this.ownerKey);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private forward(
    kind: McpClientRequestKind,
    params: unknown,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (this.disposed) {
      return Promise.reject(
        new McpClientRequestError(MCP_CLIENT_REQUEST_ERRORS.internal, 'MCP connection closed')
      );
    }
    if (signal.aborted) {
      return Promise.reject(
        new McpClientRequestError(MCP_CLIENT_REQUEST_ERRORS.internal, 'Request cancelled')
      );
    }
    // Bound what a server can push into the renderer (message + requestedSchema).
    if (serialisedLength(params) > MAX_CLIENT_REQUEST_PARAMS_BYTES) {
      return Promise.reject(
        new McpClientRequestError(
          MCP_CLIENT_REQUEST_ERRORS.invalidParams,
          `Client request exceeds ${MAX_CLIENT_REQUEST_PARAMS_BYTES} bytes`
        )
      );
    }
    let open = 0;
    for (const entry of pending.values()) if (entry.bridge === this) open++;
    if (open >= MAX_PENDING_CLIENT_REQUESTS) {
      return Promise.reject(
        new McpClientRequestError(
          MCP_CLIENT_REQUEST_ERRORS.internal,
          'Too many pending client requests on this connection'
        )
      );
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = randomUUID();
      const onAbort = () => {
        const entry = pending.get(requestId);
        if (!entry) return;
        settle(entry, 'cancelled');
        reject(new McpClientRequestError(MCP_CLIENT_REQUEST_ERRORS.internal, 'Request cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const entry: PendingClientRequest = {
        requestId,
        kind,
        params,
        bridge: this,
        resolve,
        reject,
        detachSignal: () => signal.removeEventListener('abort', onAbort),
        timer: setTimeout(() => {
          const current = pending.get(requestId);
          if (!current) return;
          settle(current, 'timeout');
          reject(
            new McpClientRequestError(
              MCP_CLIENT_REQUEST_ERRORS.timeout,
              `No user response within ${Math.round(this.timeoutMs / 1000)}s`
            )
          );
        }, this.timeoutMs),
      };
      pending.set(requestId, entry);
      const event: McpClientRequestEvent = { requestId, kind, params };
      emitTo(
        this.webContentsId,
        eventChannel(EVENT_PREFIX.mcp.clientRequest, this.connectionId),
        event
      );
    });
  }
}

/** Remove a pending entry and tell the renderer to drop its prompt. */
function settle(entry: PendingClientRequest, reason: McpClientRequestCancelledEvent['reason']) {
  release(entry);
  const event: McpClientRequestCancelledEvent = { requestId: entry.requestId, reason };
  emitTo(
    entry.bridge.webContentsId,
    eventChannel(EVENT_PREFIX.mcp.clientRequestCancelled, entry.bridge.connectionId),
    event
  );
}

function release(entry: PendingClientRequest): void {
  pending.delete(entry.requestId);
  clearTimeout(entry.timer);
  entry.detachSignal();
}

export type McpClientResponseResult =
  | { success: true }
  | { success: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Apply one renderer answer. Missing, already-settled and wrong-owner request
 * ids are deliberately indistinguishable. An invalid elicitation `accept`
 * leaves the request pending so the user can correct the form.
 */
export function resolveMcpClientResponse(
  input: McpClientResponse,
  senderId: number
): McpClientResponseResult {
  const entry = pending.get(input.requestId);
  if (
    !entry ||
    entry.bridge.webContentsId !== senderId ||
    entry.bridge.connectionId !== input.connectionId ||
    entry.kind !== input.kind
  ) {
    return { success: false, error: 'Unknown client request' };
  }

  if (input.kind === 'elicitation') {
    const { response } = input;
    if (response.action !== 'accept') {
      release(entry);
      entry.resolve({ action: response.action });
      return { success: true };
    }
    const requestedSchema = (entry.params as { requestedSchema?: unknown } | null)?.requestedSchema;
    const validation = validateElicitationContent(requestedSchema, response.content);
    if (!validation.ok) {
      return {
        success: false,
        error: 'Content does not match the requested schema',
        fieldErrors: validation.errors,
      };
    }
    release(entry);
    entry.resolve({ action: 'accept', content: validation.value });
    return { success: true };
  }

  const { response } = input;
  release(entry);
  if (response.action === 'reject') {
    entry.reject(
      new McpClientRequestError(
        MCP_CLIENT_REQUEST_ERRORS.userRejected,
        'User rejected sampling request'
      )
    );
    return { success: true };
  }
  entry.resolve({
    role: 'assistant',
    content: { type: 'text', text: response.text },
    model: response.model,
    stopReason: 'endTurn',
  });
  return { success: true };
}

/**
 * Replace the renderer's roots for one connection and notify every live
 * session of that connection. Returns how many sessions were notified.
 */
export async function setMcpRoots(
  connectionId: string,
  roots: McpRoot[],
  sender: Pick<WebContents, 'id'> & Partial<Pick<WebContents, 'isDestroyed' | 'once'>>
): Promise<{ success: true; notified: number } | { success: false; error: string }> {
  const key = ownerScopedKey(connectionId, sender.id);
  if (!rootsByOwner.has(key)) {
    let owned = 0;
    for (const entry of rootsByOwner.values()) if (entry.webContentsId === sender.id) owned++;
    if (owned >= MAX_ROOT_ENTRIES_PER_OWNER) {
      return { success: false, error: 'Too many MCP connections with roots' };
    }
  }
  rootsByOwner.set(key, { webContentsId: sender.id, roots: roots.map((root) => ({ ...root })) });
  if (typeof sender.once === 'function' && typeof sender.isDestroyed === 'function') {
    bindRendererCleanup(rootsByOwner, sender as WebContents, (deadId) =>
      disposeByOwner(rootsByOwner, deadId, () => undefined)
    );
  }

  let notified = 0;
  for (const bridge of liveBridges.get(key) ?? []) {
    if (await bridge.notifyRootsChanged()) notified++;
  }
  return { success: true, notified };
}

export function registerMcpClientRequestIPC(): void {
  ipcMain.handle(
    IPC.mcp.clientResponse,
    rateLimited(
      mcpClientResponseRateLimiter,
      createValidatedEventHandler(IPC.mcp.clientResponse, McpClientResponseSchema, (input, event) =>
        resolveMcpClientResponse(input, event.sender.id)
      )
    )
  );
  ipcMain.handle(
    IPC.mcp.setRoots,
    rateLimited(
      mcpSetRootsRateLimiter,
      createValidatedEventHandler(IPC.mcp.setRoots, McpSetRootsSchema, (input, event) =>
        setMcpRoots(input.connectionId, input.roots, event.sender)
      )
    )
  );
}

/** Module teardown: reject every parked request and forget stored roots. */
export function stopMcpClientRequests(): void {
  for (const bridges of [...liveBridges.values()]) {
    for (const bridge of [...bridges]) bridge.dispose();
  }
  for (const entry of [...pending.values()]) {
    release(entry);
    entry.reject(
      new McpClientRequestError(MCP_CLIENT_REQUEST_ERRORS.internal, 'MCP connection closed')
    );
  }
  rootsByOwner.clear();
}

/** Test seam: number of parked requests. */
export function pendingMcpClientRequestCount(): number {
  return pending.size;
}
