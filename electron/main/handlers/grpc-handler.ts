import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { createLogger } from '@shared/runtime/logger';
import { ipcMain, type WebContents } from 'electron';
import { EVENT_PREFIX, eventChannel, IPC } from '../../shared/channels';
import { bindRendererCleanup, disposeByOwner } from '../ipc/connection-cleanup';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import type { GrpcRequestConfig } from '../ipc/ipc-validators';
import {
  createValidatedHandler,
  createValidatedListener,
  GrpcRequestConfigSchema,
  GrpcSendMessageSchema,
  GrpcStreamRequestIdSchema,
} from '../ipc/ipc-validators';
import { ownerScopedKey, StreamRegistry } from '../ipc/stream-registry';
import type { LogEntry } from '../lifecycle/request-logger';
import { applyNonSignAtWireAuth } from '../security/auth-applier';
import { materializeExternalProtocolAuth } from '../security/external-secret-materializer';
import {
  executeConnectServerStreamCollect,
  executeConnectUnary,
  type PinnedDial,
  resolveGrpcDialAddress,
  runConnectStream,
} from './grpc-connect';
import { type GrpcTlsConfig, resolveGrpcExecutionPolicy } from './grpc-credentials';

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
  generation: symbol;
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
// renderer that starts streams which never finish DNS can't grow this unbounded.
interface PendingStreamClaim {
  requestId: string;
  webContentsId: number;
  token: symbol;
  writes: unknown[];
  end: boolean;
  createdAt: number;
}

const pendingStreamMessages = new Map<string, PendingStreamClaim>();
const MAX_PENDING_WRITES = 256;
const MAX_PENDING_STREAMS = 100;
// A pending buffer only bridges the start-stream DNS pre-flight (seconds); one
// that hasn't been flushed within this window belongs to an id that will never
// register (renderer bug or dead renderer) and is evicted by the stale sweep.
const PENDING_TTL_MS = 60 * 1000;

// Reserve a stream id synchronously before start-stream awaits DNS. Controls
// may buffer only against this creator-owned claim; an unknown or wrong-owner
// id is indistinguishable and remains a no-op.
const reservePendingStream = (id: string, sender: WebContents): PendingStreamClaim | undefined => {
  const key = ownerScopedKey(id, sender.id);
  if (
    pendingStreamMessages.has(key) ||
    activeCalls.has(id, sender.id) ||
    pendingStreamMessages.size >= MAX_PENDING_STREAMS
  ) {
    return undefined;
  }
  const claim: PendingStreamClaim = {
    requestId: id,
    webContentsId: sender.id,
    token: Symbol(id),
    writes: [],
    end: false,
    createdAt: Date.now(),
  };
  pendingStreamMessages.set(key, claim);
  bindRendererCleanup(pendingStreamMessages, sender, (deadId) =>
    disposeByOwner(pendingStreamMessages, deadId, () => {})
  );
  return pendingStreamMessages.get(key) === claim ? claim : undefined;
};

const pendingForOwner = (id: string, webContentsId: number): PendingStreamClaim | undefined => {
  return pendingStreamMessages.get(ownerScopedKey(id, webContentsId));
};

const releasePendingStream = (id: string, claim: PendingStreamClaim): void => {
  const key = ownerScopedKey(id, claim.webContentsId);
  if (pendingStreamMessages.get(key)?.token === claim.token) {
    pendingStreamMessages.delete(key);
  }
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
  const staleCalls: Array<{ requestId: string; webContentsId: number }> = [];
  for (const call of activeCalls.values()) {
    if (now - call.createdAt > STREAM_TIMEOUT_MS) {
      staleCalls.push({ requestId: call.requestId, webContentsId: call.webContentsId });
    }
  }
  staleCalls.forEach(({ requestId, webContentsId }) => {
    try {
      // cancel() runs dispose (c.cancel()) and removes the entry.
      activeCalls.cancel(requestId, webContentsId);
    } catch (error) {
      log.error('error canceling stale stream', {
        streamId: requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    log.info('cleaned up stale stream', { streamId: requestId });
  });
  // Evict pending buffers whose stream never registered — without this they
  // survive renderer death and park up to MAX_PENDING_STREAMS × MAX_PENDING_WRITES
  // payloads until quit.
  for (const [key, pending] of pendingStreamMessages) {
    if (now - pending.createdAt > PENDING_TTL_MS) {
      pendingStreamMessages.delete(key);
      log.info('evicted stale pending stream buffer', { streamId: pending.requestId });
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
  call: Omit<ActiveCall, 'createdAt' | 'requestId'>,
  claim: PendingStreamClaim
): boolean => {
  if (pendingForOwner(id, sender.id)?.token !== claim.token) return false;
  const entry: ActiveCall = { ...call, createdAt: Date.now(), requestId: id };
  // tryAdd rejects a duplicate id (a renderer bug) rather than replacing.
  if (!activeCalls.tryAdd(id, sender, entry)) {
    log.warn('duplicate stream rejected', { streamId: id });
    // Drop any writes/half-close that raced in under this id — the stream was
    // rejected, so they'd otherwise orphan in pendingStreamMessages until the
    // size cap or stopStreamCleanup evicts them.
    releasePendingStream(id, claim);
    return false;
  }
  // Flush any writes / half-close that raced ahead of registration (see
  // pendingStreamMessages). For server-streaming write/end are no-ops, so this
  // is harmless there.
  releasePendingStream(id, claim);
  for (const msg of claim.writes) call.write(msg);
  if (claim.end) call.end();
  return true;
};

// Safe method to remove a stream
const removeActiveCall = (id: string, webContentsId: number, generation: symbol): void => {
  if (activeCalls.get(id, webContentsId)?.generation === generation) {
    activeCalls.remove(id, webContentsId);
  }
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
  let policyConfig: GrpcRequestConfig;
  try {
    policyConfig = resolveGrpcExecutionPolicy(config);
  } catch (err) {
    const detail = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return {
      status: 2,
      statusText: 'Internal Error',
      headers: {},
      trailers: {},
      error: `gRPC setup failed: ${detail}`,
    };
  }
  // SSRF pre-flight before any disk I/O or socket open. Failure surfaces as
  // INVALID_ARGUMENT (code 3) with an explicit "[URL policy]" prefix so the
  // renderer can distinguish URL-policy rejections from a gRPC server that
  // legitimately returns INVALID_ARGUMENT for a malformed request body.
  let grpcDial: PinnedDial;
  try {
    grpcDial = await resolveGrpcDialAddress(policyConfig.url);
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

  try {
    policyConfig = {
      ...policyConfig,
      auth: await materializeExternalProtocolAuth(policyConfig.auth),
    };
  } catch (err) {
    const detail = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return {
      status: 2,
      statusText: 'Internal Error',
      headers: {},
      trailers: {},
      error: `gRPC setup failed: ${detail}`,
    };
  }
  const shared = toConnectArgs(policyConfig, grpcDial);

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
          safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
            status: 14,
            details: 'Rate limit exceeded',
          });
          return;
        }

        let policyConfig: GrpcRequestConfig;
        try {
          policyConfig = resolveGrpcExecutionPolicy(config);
        } catch (err) {
          safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
            status: 2,
            details: `gRPC setup failed: ${sanitizeErrorMessage(
              err instanceof Error ? err.message : String(err)
            )}`,
          });
          return;
        }

        // Claim this renderer's id synchronously before the first await. Another
        // renderer may independently use the same external id, while a same-owner
        // duplicate retains the existing duplicate-stream error contract.
        const ownedPending = pendingForOwner(requestId, event.sender.id);
        const ownedActive = activeCalls.getForOwner(requestId, event.sender.id);
        const claim = reservePendingStream(requestId, event.sender);
        if (!claim) {
          if (ownedPending || ownedActive) {
            safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
              status: 13,
              details: `Stream with ID ${requestId} already exists`,
            });
          }
          return;
        }

        // Resolve + validate + pin the address before opening a transport
        // (closes the DNS-rebind window).
        let grpcDial: PinnedDial;
        try {
          grpcDial = await resolveGrpcDialAddress(policyConfig.url);
        } catch (err) {
          releasePendingStream(requestId, claim);
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
        if (
          event.sender.isDestroyed() ||
          pendingForOwner(requestId, event.sender.id)?.token !== claim.token
        ) {
          releasePendingStream(requestId, claim);
          return;
        }

        // Preserve the synchronous ownership reservation and the existing
        // DNS-pinning lifecycle above; provider resolution is async and must
        // happen only after this stream is owned by the initiating renderer.
        try {
          policyConfig = {
            ...policyConfig,
            auth: await materializeExternalProtocolAuth(policyConfig.auth),
          };
        } catch (err) {
          releasePendingStream(requestId, claim);
          safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
            status: 2,
            details: `gRPC setup failed: ${sanitizeErrorMessage(
              err instanceof Error ? err.message : String(err)
            )}`,
          });
          return;
        }

        // Renderer-destroyed cleanup is wired by addActiveCall → registry.tryAdd
        // (below), once the call is registered. The isDestroyed bail above already
        // covers a renderer that died during the DNS lookup.
        const streamStartTime = Date.now();
        const generation = Symbol(requestId);

        try {
          let accumulatedSize = 0;
          const capturedHeaders: Record<string, string> = {};
          const capturedTrailers: Record<string, string> = {};
          let finalized = false;

          const cleanup = () => {
            removeActiveCall(requestId, event.sender.id, generation);
          };
          const isCurrentCall = () =>
            activeCalls.get(requestId, event.sender.id)?.generation === generation;

          // Emit the single terminal event for the stream, carrying the captured
          // response headers + trailers and the real gRPC status. OK → `status`
          // channel; non-OK → `error` channel (mirrors the renderer's split).
          // Guarded so the first terminal signal wins — a connect-node close
          // (status/error), a size-limit trip, or a deadline. Previously this hardcoded
          // status 0 and dropped headers/trailers on every streaming call.
          const finalize = (code: number, details: string) => {
            if (finalized || !isCurrentCall()) return;
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
                method: `${policyConfig.service}/${policyConfig.method}`,
                url: policyConfig.url,
                status: code,
                durationMs: Date.now() - streamStartTime,
                protocol: 'grpc',
                ...(code !== 0 ? { error: sanitizeErrorMessage(details) } : {}),
              });
            }
            cleanup();
          };

          const handleData = (data: unknown) => {
            if (finalized || !isCurrentCall()) return;
            accumulatedSize += estimateSize(data);
            if (accumulatedSize > MAX_RESPONSE_SIZE) {
              // Cancel the still-registered call first; finalize() then sets the
              // guard so the CANCELLED status the cancel triggers is ignored.
              const current = activeCalls.get(requestId, event.sender.id);
              if (current?.generation !== generation) return;
              current.cancel();
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
          const controls = runConnectStream(toConnectArgs(policyConfig, grpcDial), {
            onMessage: handleData,
            onHeaders: (h) => {
              if (isCurrentCall()) Object.assign(capturedHeaders, h);
            },
            onTrailers: (t) => {
              if (isCurrentCall()) Object.assign(capturedTrailers, t);
            },
            onClose: finalize,
            onCancelled: () => {
              if (!finalized && isCurrentCall()) {
                finalized = true;
                cleanup();
              }
            },
          });
          const added = addActiveCall(
            requestId,
            event.sender,
            {
              cancel: controls.cancel,
              write: controls.write,
              end: controls.end,
              generation,
              webContentsId: event.sender.id,
            },
            claim
          );
          if (!added) {
            controls.cancel();
            safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
              status: 13,
              details: `Stream with ID ${requestId} already exists`,
            });
          }
        } catch (err: unknown) {
          releasePendingStream(requestId, claim);
          const error = err instanceof Error ? err : new Error(String(err));
          safeSend(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
            status: 2,
            details: sanitizeErrorMessage(error.message),
          });
          removeActiveCall(requestId, event.sender.id, generation);
        }
      }
    )
  );

  ipcMain.on(
    IPC.grpc.sendMessage,
    createValidatedListener(
      IPC.grpc.sendMessage,
      GrpcSendMessageSchema,
      (event, [requestId, message]) => {
        const call = activeCalls.getForOwner(requestId, event.sender.id);
        if (call) {
          call.write(message);
          return;
        }
        // Stream not registered yet — start-stream is still resolving DNS.
        // Buffer only for the renderer that reserved the stream id.
        const pending = pendingForOwner(requestId, event.sender.id);
        if (pending && pending.writes.length < MAX_PENDING_WRITES) pending.writes.push(message);
      }
    )
  );

  ipcMain.on(
    IPC.grpc.endStream,
    createValidatedListener(
      IPC.grpc.endStream,
      GrpcStreamRequestIdSchema,
      (event, requestId: string) => {
        const call = activeCalls.getForOwner(requestId, event.sender.id);
        if (call) {
          call.end();
          return;
        }
        // Half-close raced ahead of registration — record it for the flush.
        const pending = pendingForOwner(requestId, event.sender.id);
        if (pending) pending.end = true;
      }
    )
  );

  ipcMain.on(
    IPC.grpc.cancelStream,
    createValidatedListener(
      IPC.grpc.cancelStream,
      GrpcStreamRequestIdSchema,
      (event, requestId: string) => {
        const pending = pendingForOwner(requestId, event.sender.id);
        if (pending) releasePendingStream(requestId, pending);
        activeCalls.cancelForOwner(requestId, event.sender.id);
      }
    )
  );
}
