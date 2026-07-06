import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { ipcMain } from 'electron';
import { createLogger } from '../../../src/lib/shared/logger';
import { IPC, EVENT_PREFIX, eventChannel } from '../../shared/channels';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import type { GrpcRequestConfig } from '../ipc/ipc-validators';
import {
  GrpcRequestConfigSchema,
  GrpcStreamRequestIdSchema,
  GrpcSendMessageSchema,
  createValidatedHandler,
  createValidatedListener,
} from '../ipc/ipc-validators';
import { StreamRegistry } from '../ipc/stream-registry';
import type { LogEntry } from '../lifecycle/request-logger';
import { applyNonSignAtWireAuth } from '../security/auth-applier';
import {
  resolveGrpcDialAddress,
  executeConnectUnary,
  executeConnectServerStreamCollect,
  runConnectStream,
  type PinnedDial,
} from './grpc-connect';
import type { GrpcTlsConfig } from './grpc-credentials';

const log = createLogger('grpc');

export const grpcRateLimiter = createKeyedRateLimiter(30, 60_000);

// Belt-and-braces guard on the stream id used to key activeCalls.
const SAFE_GRPC_ID_RE = /^[a-zA-Z0-9_-]+$/;

interface GrpcResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  message?: unknown;
  messages?: unknown[];
  trailers: Record<string, string>;
  error?: string;
  details?: string;
}

interface ActiveCall {
  cancel: () => void;
  write: (msg: unknown) => void;
  end: () => void;
  createdAt: number; // Timestamp for stale connection detection
  requestId: string; // Request ID for tracking
  /** webContents.id of the renderer that started the stream — used for renderer-destroyed teardown. */
  webContentsId: number;
}

// Store active calls for streaming. The registry owns the map + renderer-destroyed
// cleanup (dispose = cancel the call). gRPC keeps its own bespoke bits — the
// stale-stream sweeper (createdAt), the duplicate-id rejection (tryAdd, not the
// replacing add), and the pendingStreamMessages race buffer — as custom logic
// over get()/values()/tryAdd().
const activeCalls = new StreamRegistry<ActiveCall>({ dispose: (c) => c.cancel() });

// `grpc:start-stream` is async (it awaits a DNS SSRF pre-flight before it can
// register the ActiveCall). A `grpc:send-message` / `grpc:end-stream` that races
// ahead of that registration would otherwise be dropped silently — losing the
// first client/bidi message or a premature half-close. Buffer those per
// requestId and flush them in addActiveCall. Bounded (per-id + map size) so a
// renderer that sends to an id that never registers can't grow this unbounded.
const pendingStreamMessages = new Map<
  string,
  { writes: unknown[]; end: boolean; createdAt: number }
>();
const MAX_PENDING_WRITES = 256;
const MAX_PENDING_STREAMS = 100;
// A pending buffer only bridges the start-stream DNS pre-flight (seconds); one
// that hasn't been flushed within this window belongs to an id that will never
// register (renderer bug or dead renderer) and is evicted by the stale sweep.
const PENDING_TTL_MS = 60 * 1000;

// Get (or create, if room) the pending buffer for a not-yet-registered stream.
// Returns null when the map is at capacity so callers drop the message rather
// than grow the buffer unbounded for an id that may never register.
const getOrCreatePending = (
  id: string
): { writes: unknown[]; end: boolean; createdAt: number } | null => {
  let pending = pendingStreamMessages.get(id);
  if (!pending) {
    if (pendingStreamMessages.size >= MAX_PENDING_STREAMS) return null;
    pending = { writes: [], end: false, createdAt: Date.now() };
    pendingStreamMessages.set(id, pending);
  }
  return pending;
};

// Timeout for stale streams (5 minutes)
const STREAM_TIMEOUT_MS = 5 * 60 * 1000;

// Helper to estimate object size in bytes
function estimateSize(obj: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8');
  } catch {
    return 0;
  }
}

// Sanitize error messages to remove internal details
function sanitizeErrorMessage(message: string | undefined): string {
  if (!message) return 'Unknown error';

  // Remove file paths
  let sanitized = message.replace(/\/[^\s]+\.(ts|js|proto)/g, '[file]');

  // Remove stack traces
  sanitized = sanitized.replace(/\s+at\s+.+/g, '');

  // Remove internal error codes/references
  sanitized = sanitized.replace(/\[internal:[^\]]+\]/gi, '');

  // Truncate very long messages
  if (sanitized.length > 500) {
    sanitized = sanitized.substring(0, 500) + '...';
  }

  return sanitized || 'Unknown error';
}

// Clean up stale streams periodically
const cleanupStaleStreams = () => {
  const now = Date.now();
  // Collect first, then cancel — cancel() disposes + removes, so mutating the
  // map mid-iteration is avoided.
  const staleIds: string[] = [];
  for (const call of activeCalls.values()) {
    if (now - call.createdAt > STREAM_TIMEOUT_MS) staleIds.push(call.requestId);
  }
  staleIds.forEach((id) => {
    try {
      // cancel() runs dispose (c.cancel()) and removes the entry.
      activeCalls.cancel(id);
    } catch (error) {
      log.error('error canceling stale stream', {
        streamId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    log.info('cleaned up stale stream', { streamId: id });
  });
  // Evict pending buffers whose stream never registered — without this they
  // survive renderer death and park up to MAX_PENDING_STREAMS × MAX_PENDING_WRITES
  // payloads until quit.
  for (const [id, pending] of pendingStreamMessages) {
    if (now - pending.createdAt > PENDING_TTL_MS) {
      pendingStreamMessages.delete(id);
      log.info('evicted stale pending stream buffer', { streamId: id });
    }
  }
};

// Run cleanup every minute
let cleanupInterval: NodeJS.Timeout | null = null;

export function startStreamCleanup(): void {
  if (cleanupInterval) return; // Already running
  cleanupInterval = setInterval(cleanupStaleStreams, 60 * 1000);
}

export function stopStreamCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  // Cancel all active streams so we don't block process exit (dispose = cancel).
  activeCalls.disposeAll();
  pendingStreamMessages.clear();
}

// Safe method to add a stream with collision detection. `sender` is threaded to
// the registry so renderer-destroyed cleanup is wired at store time (tryAdd binds
// it; if the renderer already died, it disposes immediately).
const addActiveCall = (
  id: string,
  sender: Electron.WebContents,
  call: Omit<ActiveCall, 'createdAt' | 'requestId'>
): boolean => {
  const entry: ActiveCall = { ...call, createdAt: Date.now(), requestId: id };
  // tryAdd rejects a duplicate id (a renderer bug) rather than replacing.
  if (!activeCalls.tryAdd(id, sender, entry)) {
    log.warn('duplicate stream rejected', { streamId: id });
    // Drop any writes/half-close that raced in under this id — the stream was
    // rejected, so they'd otherwise orphan in pendingStreamMessages until the
    // size cap or stopStreamCleanup evicts them.
    pendingStreamMessages.delete(id);
    return false;
  }
  // Flush any writes / half-close that raced ahead of registration (see
  // pendingStreamMessages). For server-streaming write/end are no-ops, so this
  // is harmless there.
  const pending = pendingStreamMessages.get(id);
  if (pending) {
    pendingStreamMessages.delete(id);
    for (const msg of pending.writes) call.write(msg);
    if (pending.end) call.end();
  }
  return true;
};

// Safe method to remove a stream
const removeActiveCall = (id: string): void => {
  activeCalls.remove(id);
};

// Pull the TLS trust / mTLS material out of a request config for the
// connect-node transport builder (shared by the unary + streaming call paths).
function tlsFromConfig(config: GrpcRequestConfig): GrpcTlsConfig {
  return {
    verifySsl: config.verifySsl,
    clientCert: config.clientCert,
    caCert: config.caCert,
  };
}

/**
 * Merge handle-backed auth resolved main-side into the gRPC metadata record.
 * The renderer drops SecretRef-handle credentials (it can't read plaintext);
 * when `auth` is present we resolve it here via the OS keychain and add the
 * resulting header(s) as lowercase metadata keys (gRPC's canonical form).
 * api-key `in:'query'` placement has no meaning for gRPC, so params are dropped.
 */
export function mergeMainSideAuth(
  metadata: Record<string, string>,
  auth: GrpcRequestConfig['auth']
): Record<string, string> {
  if (!auth) return metadata;
  const { headers } = applyNonSignAtWireAuth(auth as Parameters<typeof applyNonSignAtWireAuth>[0]);
  if (Object.keys(headers).length === 0) return metadata;
  const merged = { ...metadata };
  for (const [k, v] of Object.entries(headers)) merged[k.toLowerCase()] = v;
  return merged;
}

// Build the connect-node call args (shared by the unary / streaming executors)
// from a request config + its SSRF-validated dial.
function toConnectArgs(config: GrpcRequestConfig, dial: PinnedDial) {
  return {
    url: config.url,
    dial,
    tls: tlsFromConfig(config),
    service: config.service,
    method: config.method,
    descriptors: config.descriptors,
    protoContent: config.protoContent,
    message: config.message,
    metadata: mergeMainSideAuth(config.metadata, config.auth),
    timeoutMs: config.timeoutMs,
    useCompression: config.useCompression,
  };
}

async function makeGrpcRequest(config: GrpcRequestConfig): Promise<GrpcResponse> {
  // SSRF pre-flight before any disk I/O or socket open. Failure surfaces as
  // INVALID_ARGUMENT (code 3) with an explicit "[URL policy]" prefix so the
  // renderer can distinguish URL-policy rejections from a gRPC server that
  // legitimately returns INVALID_ARGUMENT for a malformed request body.
  let grpcDial: PinnedDial;
  try {
    grpcDial = await resolveGrpcDialAddress(config.url);
  } catch (err) {
    const detail = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return {
      status: 3,
      statusText: 'INVALID_ARGUMENT',
      headers: {},
      trailers: {},
      error: '[URL policy] ' + detail,
      details: '[URL policy] ' + detail,
    };
  }

  const shared = toConnectArgs(config, grpcDial);

  try {
    if (config.methodType === 'unary') {
      const r = await executeConnectUnary(shared);
      const out: GrpcResponse = {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
        trailers: r.trailers,
        ...(r.message !== undefined ? { message: r.message } : {}),
      };
      if (r.error) out.error = sanitizeErrorMessage(r.error);
      if (r.details) out.details = sanitizeErrorMessage(r.details);
      return out;
    }
    if (config.methodType === 'server-streaming') {
      const r = await executeConnectServerStreamCollect(shared);
      const out: GrpcResponse = {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
        trailers: r.trailers,
        messages: r.messages,
      };
      if (r.error) out.error = sanitizeErrorMessage(r.error);
      return out;
    }
    // client/bidi aren't buffered — they run live via grpc:start-stream.
    return {
      status: 2,
      statusText: 'Internal Error',
      headers: {},
      trailers: {},
      error: `Method type ${config.methodType} not supported in synchronous mode`,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      status: 2,
      statusText: 'Internal Error',
      headers: {},
      trailers: {},
      error: `gRPC setup failed: ${sanitizeErrorMessage(error.message)}`,
    };
  }
}

export function registerGrpcHandlerIPC(onComplete?: (entry: LogEntry) => void): void {
  // Start periodic cleanup of stale streams
  startStreamCleanup();

  ipcMain.handle(
    IPC.grpc.request,
    rateLimited(
      grpcRateLimiter,
      createValidatedHandler(
        IPC.grpc.request,
        GrpcRequestConfigSchema,
        async (config: GrpcRequestConfig) => {
          const startTime = Date.now();
          const result = await makeGrpcRequest(config);
          if (onComplete) {
            onComplete({
              ts: startTime,
              method: `${config.service}/${config.method}`,
              url: config.url,
              status: result.status,
              durationMs: Date.now() - startTime,
              protocol: 'grpc',
              error: result.error,
            });
          }
          return result;
        }
      )
    )
  );

  ipcMain.on(
    IPC.grpc.startStream,
    createValidatedListener(
      IPC.grpc.startStream,
      GrpcRequestConfigSchema,
      async (event, config: GrpcRequestConfig) => {
        const requestId = config.id;
        if (!requestId || !SAFE_GRPC_ID_RE.test(requestId)) return;

        // Helper: never send to a destroyed renderer. The handler became async
        // for the SSRF pre-flight (DNS lookup), so `event.sender` may have been
        // destroyed by the time we try to report an error. Without this guard
        // the send throws, the rejection escapes `createValidatedListener`'s
        // sync try/catch, and we surface as an unhandled rejection.
        const safeSend = (channel: string, payload: unknown): void => {
          if (event.sender.isDestroyed()) return;
          try {
            event.sender.send(channel, payload);
          } catch {
            // Sender went away mid-send; nothing more to do.
          }
        };

        if (!grpcRateLimiter.check(event.sender.id)) {
          pendingStreamMessages.delete(requestId);
          safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
            status: 14,
            details: 'Rate limit exceeded',
          });
          return;
        }

        // SSRF guard before any cleanup binding so a rejected URL doesn't leave a
        // renderer-destroy listener behind. Resolve + validate + pin the address
        // here (closes the rebind window).
        let grpcDial: PinnedDial;
        try {
          grpcDial = await resolveGrpcDialAddress(config.url);
        } catch (err) {
          pendingStreamMessages.delete(requestId);
          safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
            status: 3,
            details:
              '[URL policy] ' +
              sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
          });
          return;
        }

        // Renderer may have been destroyed during the DNS lookup; bail out
        // before allocating cleanup listeners and temp directories.
        if (event.sender.isDestroyed()) {
          pendingStreamMessages.delete(requestId);
          return;
        }

        // Renderer-destroyed cleanup is wired by addActiveCall → registry.tryAdd
        // (below), once the call is registered. The isDestroyed bail above already
        // covers a renderer that died during the DNS lookup.
        const streamStartTime = Date.now();

        try {
          let accumulatedSize = 0;
          const capturedHeaders: Record<string, string> = {};
          const capturedTrailers: Record<string, string> = {};
          let finalized = false;

          const cleanup = () => {
            removeActiveCall(requestId);
          };

          // Emit the single terminal event for the stream, carrying the captured
          // response headers + trailers and the real gRPC status. OK → `status`
          // channel; non-OK → `error` channel (mirrors the renderer's split).
          // Guarded so the first terminal signal wins — a connect-node close
          // (status/error), a size-limit trip, or a deadline. Previously this hardcoded
          // status 0 and dropped headers/trailers on every streaming call.
          const finalize = (code: number, details: string) => {
            if (finalized) return;
            finalized = true;
            if (code === 0) {
              safeSend(eventChannel(EVENT_PREFIX.grpc.status, requestId), {
                status: 0,
                details: details || 'OK',
                headers: capturedHeaders,
                trailers: capturedTrailers,
              });
            } else {
              safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
                status: code,
                details: sanitizeErrorMessage(details),
                headers: capturedHeaders,
                trailers: capturedTrailers,
              });
            }
            if (onComplete) {
              onComplete({
                ts: streamStartTime,
                method: `${config.service}/${config.method}`,
                url: config.url,
                status: code,
                durationMs: Date.now() - streamStartTime,
                protocol: 'grpc',
                ...(code !== 0 ? { error: sanitizeErrorMessage(details) } : {}),
              });
            }
            cleanup();
          };

          const handleData = (data: unknown) => {
            if (finalized) return;
            accumulatedSize += estimateSize(data);
            if (accumulatedSize > MAX_RESPONSE_SIZE) {
              // Cancel the still-registered call first; finalize() then sets the
              // guard so the CANCELLED status the cancel triggers is ignored.
              activeCalls.get(requestId)?.cancel();
              finalize(
                8, // RESOURCE_EXHAUSTED
                `Response size exceeded maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`
              );
              return;
            }
            safeSend(eventChannel(EVENT_PREFIX.grpc.data, requestId), data);
          };

          // connect-node streaming (server / client / bidi). Reuses the
          // SSRF-validated dial, the runtime registry, and the finalize /
          // handleData / emit plumbing above.
          const controls = runConnectStream(toConnectArgs(config, grpcDial), {
            onMessage: handleData,
            onHeaders: (h) => Object.assign(capturedHeaders, h),
            onTrailers: (t) => Object.assign(capturedTrailers, t),
            onClose: finalize,
            onCancelled: () => {
              if (!finalized) {
                finalized = true;
                cleanup();
              }
            },
          });
          const added = addActiveCall(requestId, event.sender, {
            cancel: controls.cancel,
            write: controls.write,
            end: controls.end,
            webContentsId: event.sender.id,
          });
          if (!added) {
            controls.cancel();
            safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
              status: 13,
              details: `Stream with ID ${requestId} already exists`,
            });
          }
        } catch (err: unknown) {
          pendingStreamMessages.delete(requestId);
          const error = err instanceof Error ? err : new Error(String(err));
          safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
            status: 2,
            details: sanitizeErrorMessage(error.message),
          });
          removeActiveCall(requestId);
        }
      }
    )
  );

  ipcMain.on(
    IPC.grpc.sendMessage,
    createValidatedListener(
      IPC.grpc.sendMessage,
      GrpcSendMessageSchema,
      (_event, [requestId, message]) => {
        const call = activeCalls.get(requestId);
        if (call) {
          call.write(message);
          return;
        }
        // Stream not registered yet — start-stream is still resolving DNS.
        // Buffer so the write isn't lost to the race; addActiveCall flushes it.
        const pending = getOrCreatePending(requestId);
        if (pending && pending.writes.length < MAX_PENDING_WRITES) pending.writes.push(message);
      }
    )
  );

  ipcMain.on(
    IPC.grpc.endStream,
    createValidatedListener(
      IPC.grpc.endStream,
      GrpcStreamRequestIdSchema,
      (_event, requestId: string) => {
        const call = activeCalls.get(requestId);
        if (call) {
          call.end();
          return;
        }
        // Half-close raced ahead of registration — record it for the flush.
        const pending = getOrCreatePending(requestId);
        if (pending) pending.end = true;
      }
    )
  );

  ipcMain.on(
    IPC.grpc.cancelStream,
    createValidatedListener(
      IPC.grpc.cancelStream,
      GrpcStreamRequestIdSchema,
      (_event, requestId: string) => {
        pendingStreamMessages.delete(requestId);
        const call = activeCalls.get(requestId);
        if (call) {
          call.cancel();
          removeActiveCall(requestId); // cleanup immediately; the stream's onCancelled path also calls cleanup but Map.delete is idempotent
        }
      }
    )
  );
}
