/**
 * MCP control server — Electron glue (ADR 0041).
 *
 * Owns the lifecycle of the loopback listener (`mcp-control-server.ts`) and
 * the bridge that forwards each agent tool call to the renderer that turned
 * the server on:
 *
 *   agent ──HTTP──► listener ──ToolCallBridge──► owner renderer (consent,
 *         ◄──────── result ◄──── mcp-control:tool-result ◄── approval, stores)
 *
 * The renderer is the single source of truth and the single writer: main
 * holds no copy of collections or environments and makes no policy decision
 * beyond "is this the owner renderer answering a call it was sent".
 *
 * A forwarded call settles exactly once: on the owner's answer, on timeout, on
 * the agent cancelling (SDK abort signal), or when the server stops / the
 * owner renderer is destroyed. Every non-answer settlement emits
 * `mcp-control:tool-cancelled` so the renderer drops a pending approval card.
 */

import { randomUUID } from 'node:crypto';
import {
  type ControlServerStartOptions,
  ControlServerStartSchema,
  type ControlServerStatus,
  type ControlToolResult,
  MAX_IN_FLIGHT_TOOL_CALLS,
  MAX_TOOL_RESULT_BYTES,
  TOOL_CALL_TIMEOUT_MS,
  type ToolCallEvent,
  type ToolCallResultPayload,
  ToolCallResultPayloadSchema,
} from '@shared/mcp-server/control-bridge';
import { isControlToolName } from '@shared/mcp-server/control-tools';
import { createLogger } from '@shared/runtime/logger';
import { app, ipcMain, type WebContents } from 'electron';
import { EVENT, IPC } from '../../shared/channels';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { emitTo, errorMessage } from '../ipc/ipc-utils';
import {
  createValidatedEventHandler,
  createValidatedHandler,
  NoInputSchema,
} from '../ipc/ipc-validators';
import { mintToken, readHandshake, writeHandshake } from './mcp-control-protocol';
import {
  type ControlHttpServerHandle,
  type ControlToolCall,
  startControlHttpServer,
} from './mcp-control-server';

const log = createLogger('mcp-control');

// ---------------------------------------------------------------------------
// Tool-call bridge (main ⇄ owner renderer)
// ---------------------------------------------------------------------------

export type ToolCallEmitter = (webContentsId: number, channel: string, payload: unknown) => void;

interface PendingCall {
  ownerId: number;
  resolve: (result: ControlToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
  detachSignal: () => void;
}

function serialisedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Parks forwarded tool calls until the owner renderer answers. Electron-free
 * apart from the injected emitter, so it is unit-tested directly.
 */
export class ToolCallBridge {
  private readonly pending = new Map<string, PendingCall>();
  private ownerId: number | null = null;

  constructor(
    private readonly emit: ToolCallEmitter,
    private readonly timeoutMs: number = TOOL_CALL_TIMEOUT_MS
  ) {}

  setOwner(webContentsId: number | null): void {
    if (this.ownerId !== null && this.ownerId !== webContentsId) {
      this.disposeAll('The Restura window that owned the MCP server went away.');
    }
    this.ownerId = webContentsId;
  }

  get owner(): number | null {
    return this.ownerId;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  call(call: ControlToolCall): Promise<ControlToolResult> {
    const ownerId = this.ownerId;
    if (ownerId === null) {
      return Promise.resolve({
        ok: false,
        error: 'The Restura window is not ready. Open Restura and try again.',
      });
    }
    if (!isControlToolName(call.tool)) {
      return Promise.resolve({ ok: false, error: `Unknown tool: ${call.tool}` });
    }
    if (this.pending.size >= MAX_IN_FLIGHT_TOOL_CALLS) {
      return Promise.resolve({
        ok: false,
        error: 'Too many tool calls are waiting for Restura. Wait for earlier calls to finish.',
      });
    }
    if (call.signal.aborted) {
      return Promise.resolve({ ok: false, error: 'Tool call cancelled by the client.' });
    }

    const callId = randomUUID();
    return new Promise<ControlToolResult>((resolve) => {
      const onAbort = () =>
        this.settle(callId, { ok: false, error: 'Tool call cancelled by the client.' }, true);
      call.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () =>
          this.settle(
            callId,
            { ok: false, error: 'Restura did not answer in time (the approval may have expired).' },
            true
          ),
        this.timeoutMs
      );
      this.pending.set(callId, {
        ownerId,
        resolve,
        timer,
        detachSignal: () => call.signal.removeEventListener('abort', onAbort),
      });
      const event: ToolCallEvent = {
        callId,
        tool: call.tool,
        input: call.input,
        ...(call.client ? { client: call.client } : {}),
      };
      this.emit(ownerId, EVENT.mcpControlToolCall, event);
    });
  }

  /**
   * Accept the renderer's answer. Returns false when the call is unknown
   * (already settled) or the sender is not the renderer it was sent to.
   */
  resolveFromRenderer(senderId: number, payload: ToolCallResultPayload): boolean {
    const entry = this.pending.get(payload.callId);
    if (!entry || entry.ownerId !== senderId) return false;
    const result: ControlToolResult =
      serialisedLength(payload.result) > MAX_TOOL_RESULT_BYTES
        ? {
            ok: false,
            error: `The result was larger than ${MAX_TOOL_RESULT_BYTES} bytes. Narrow the request (for example a smaller maxBodyChars).`,
          }
        : payload.result;
    this.settle(payload.callId, result, false);
    return true;
  }

  disposeAll(reason: string): void {
    for (const callId of [...this.pending.keys()]) {
      this.settle(callId, { ok: false, error: reason }, true);
    }
  }

  private settle(callId: string, result: ControlToolResult, notifyRenderer: boolean): void {
    const entry = this.pending.get(callId);
    if (!entry) return;
    this.pending.delete(callId);
    clearTimeout(entry.timer);
    entry.detachSignal();
    if (notifyRenderer) this.emit(entry.ownerId, EVENT.mcpControlToolCancelled, { callId });
    entry.resolve(result);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

interface ActiveServer {
  handle: ControlHttpServerHandle;
  token: string;
  owner: WebContents;
  onOwnerDestroyed: () => void;
}

const bridge = new ToolCallBridge((id, channel, payload) => emitTo(id, channel, payload));
let active: ActiveServer | null = null;
let lastCallAt: number | undefined;
/** Serialises start/stop so concurrent toggles cannot leak a listener. */
let lifecycle: Promise<unknown> = Promise.resolve();

function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(fn, fn);
  lifecycle = next.catch(() => undefined);
  return next;
}

export function getControlServerStatus(): ControlServerStatus {
  if (!active) return { running: false, inFlight: bridge.inFlight };
  return {
    running: true,
    port: active.handle.port,
    url: active.handle.url,
    ...(lastCallAt !== undefined ? { lastCallAt } : {}),
    inFlight: bridge.inFlight,
  };
}

async function startInternal(
  owner: WebContents,
  options: ControlServerStartOptions
): Promise<{ status: ControlServerStatus; token: string }> {
  await stopInternal('The MCP server restarted.');
  const userData = app.getPath('userData');
  const previous = await readHandshake(userData);
  // A fresh token on every start: a long-lived token could be captured by
  // another local user squatting the port while Restura is closed. The stdio
  // shim re-reads the handshake on every call, so it never notices; only
  // direct HTTP configs need the new token. The port is kept when free.
  const token = mintToken();
  const preferredPort = options.preferredPort ?? previous?.port;

  const handle = await startControlHttpServer({
    identity: { name: 'restura', version: app.getVersion() },
    getToken: () => (active ? active.token : ''),
    dispatch: (call) => bridge.call(call),
    ...(preferredPort !== undefined ? { preferredPort } : {}),
    onAuthenticatedRequest: () => {
      lastCallAt = Date.now();
    },
  });

  const onOwnerDestroyed = () => {
    void serialised(() => stopInternal('The Restura window closed.'));
  };
  owner.once('destroyed', onOwnerDestroyed);
  active = { handle, token, owner, onOwnerDestroyed };
  bridge.setOwner(owner.id);

  try {
    await writeHandshake(userData, {
      version: 1,
      running: true,
      port: handle.port,
      token,
      pid: process.pid,
      updatedAt: Date.now(),
    });
  } catch (err) {
    log.error('failed to write MCP handshake file', { error: errorMessage(err) });
  }
  log.info('MCP control server listening', { port: handle.port });
  return { status: getControlServerStatus(), token };
}

async function stopInternal(reason: string): Promise<ControlServerStatus> {
  const current = active;
  if (!current) return getControlServerStatus();
  active = null;
  bridge.disposeAll(reason);
  bridge.setOwner(null);
  if (!current.owner.isDestroyed()) {
    current.owner.removeListener('destroyed', current.onOwnerDestroyed);
  }
  await current.handle.close();
  try {
    await writeHandshake(app.getPath('userData'), {
      version: 1,
      running: false,
      port: current.handle.port,
      token: current.token,
      pid: process.pid,
      updatedAt: Date.now(),
    });
  } catch (err) {
    log.warn('failed to update MCP handshake file', { error: errorMessage(err) });
  }
  log.info('MCP control server stopped');
  return getControlServerStatus();
}

export function stopMcpControlServer(): Promise<ControlServerStatus> {
  return serialised(() => stopInternal('Restura is quitting.'));
}

// Lifecycle IPC is human-paced; results follow agent traffic.
const lifecycleRateLimiter = createKeyedRateLimiter(30, 60_000);
const resultRateLimiter = createKeyedRateLimiter(1_200, 60_000);

/**
 * At app start no control server can be running (the app is single-instance),
 * so a handshake still saying `running: true` is left over from a crash.
 * Mark it stopped so the shim reports "not running" instead of dialling a
 * port someone else may now hold.
 */
export async function markStaleHandshakeStopped(userDataDir: string): Promise<void> {
  const previous = await readHandshake(userDataDir);
  if (!previous?.running || previous.pid === process.pid) return;
  await writeHandshake(userDataDir, { ...previous, running: false, updatedAt: Date.now() });
}

export function registerMcpControlIPC(): void {
  void markStaleHandshakeStopped(app.getPath('userData')).catch((err: unknown) => {
    log.warn('could not reset a stale MCP handshake file', { error: errorMessage(err) });
  });

  ipcMain.handle(
    IPC.mcpControl.start,
    rateLimited(
      lifecycleRateLimiter,
      createValidatedEventHandler(
        IPC.mcpControl.start,
        ControlServerStartSchema.optional(),
        async (input, event) => {
          try {
            const { status, token } = await serialised(() =>
              startInternal(event.sender, input ?? {})
            );
            // The token goes only to the trusted renderer, for the copyable
            // HTTP client config; it is never served over the listener.
            return { ok: true as const, status, token };
          } catch (err) {
            log.error('MCP control server failed to start', { error: errorMessage(err) });
            return { ok: false as const, error: errorMessage(err) };
          }
        }
      )
    )
  );

  ipcMain.handle(
    IPC.mcpControl.stop,
    rateLimited(
      lifecycleRateLimiter,
      createValidatedHandler(IPC.mcpControl.stop, NoInputSchema, async () => ({
        ok: true as const,
        status: await serialised(() => stopInternal('The MCP server was turned off.')),
      }))
    )
  );

  ipcMain.handle(
    IPC.mcpControl.status,
    rateLimited(
      lifecycleRateLimiter,
      createValidatedHandler(IPC.mcpControl.status, NoInputSchema, () => ({
        ok: true as const,
        status: getControlServerStatus(),
      }))
    )
  );

  ipcMain.handle(
    IPC.mcpControl.toolResult,
    rateLimited(
      resultRateLimiter,
      createValidatedEventHandler(
        IPC.mcpControl.toolResult,
        ToolCallResultPayloadSchema,
        (payload, event) => ({ ok: bridge.resolveFromRenderer(event.sender.id, payload) })
      )
    )
  );
}

export async function disposeMcpControlIPC(): Promise<void> {
  await stopMcpControlServer();
  ipcMain.removeHandler(IPC.mcpControl.start);
  ipcMain.removeHandler(IPC.mcpControl.stop);
  ipcMain.removeHandler(IPC.mcpControl.status);
  ipcMain.removeHandler(IPC.mcpControl.toolResult);
}
