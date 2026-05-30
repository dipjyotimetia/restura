import { ipcMain, app } from 'electron';
import type { LogEntry } from './request-logger';
import type * as grpc from '@grpc/grpc-js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { GrpcRequestConfig } from './ipc-validators';
import {
  GrpcRequestConfigSchema,
  GrpcStreamRequestIdSchema,
  GrpcSendMessageSchema,
  createValidatedHandler,
  createValidatedListener,
} from './ipc-validators';
import { createKeyedRateLimiter, rateLimited } from './ipc-rate-limiter';
import { bindRendererCleanup, disposeByOwner } from './connection-cleanup';
import { applyNonSignAtWireAuth } from './auth-applier';
import { resolveUrlHostnameSafe } from './dns-guard';
import { IPC, EVENT_PREFIX, eventChannel } from '../shared/channels';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';
import { getGrpc, getProtoLoader } from './grpc-lazy';

// gRPC schemes the SSRF guard must accept; `validateURL` defaults to http/https,
// but the reflection handler and the renderer both also produce grpc:// URLs.
const GRPC_ALLOWED_SCHEMES = ['http:', 'https:', 'grpc:', 'grpcs:'];

export interface GrpcDialAddress {
  ip: string;
  port: number;
  family: 4 | 6;
}

// SSRF guard for gRPC. `@grpc/grpc-js` resolves DNS inside its C++ binding with
// no Node connector hook, so a pre-flight check alone leaves a TTL=0 rebind
// window. We close it by resolving + validating here, then dialing the pinned
// IP literal (see computeGrpcDial) instead of letting grpc-js re-resolve the
// hostname. See docs/adr/0006-electron-connection-and-dns-hardening.md.
async function resolveGrpcDialAddress(url: string): Promise<GrpcDialAddress> {
  const records = await resolveUrlHostnameSafe(url, {
    allowLocalhost: true,
    allowedSchemes: GRPC_ALLOWED_SCHEMES,
  });
  const chosen = records[0];
  if (!chosen) throw new Error(`DNS resolution returned no records for ${new URL(url).hostname}`);
  const parsed = new URL(url);
  const useTls = url.startsWith('https://') || url.startsWith('grpcs://');
  const port = parsed.port ? parseInt(parsed.port, 10) : useTls ? 443 : 80;
  return { ip: chosen.address, port, family: chosen.family === 6 ? 6 : 4 };
}

/**
 * Compute the gRPC dial target + channel options that PIN the connection to a
 * pre-validated IP. The original hostname is kept as the gRPC authority (and,
 * for TLS, the SSL target name) so `:authority` routing and certificate
 * validation behave exactly as if grpc-js had resolved the name itself —
 * grpc-js just never gets the chance to re-resolve (and be rebound). Pure +
 * exported so the pinning logic is unit-tested without a live handshake.
 */
export function computeGrpcDial(
  url: string,
  pinned: GrpcDialAddress
): { target: string; useTls: boolean; channelOptions: grpc.ChannelOptions } {
  const host = new URL(url).hostname;
  const useTls = url.startsWith('https://') || url.startsWith('grpcs://');
  const target =
    pinned.family === 6 ? `[${pinned.ip}]:${pinned.port}` : `${pinned.ip}:${pinned.port}`;
  const channelOptions: grpc.ChannelOptions = {
    'grpc.default_authority': host,
    ...(useTls ? { 'grpc.ssl_target_name_override': host } : {}),
  };
  return { target, useTls, channelOptions };
}

export const grpcRateLimiter = createKeyedRateLimiter(30, 60_000);

// Use app's userData directory for proto temp files (more secure than os.tmpdir())
// This will be something like ~/Library/Application Support/restura/grpc-temp on macOS
const getGrpcTempDir = () => {
  try {
    // Try to use app.getPath if available (Electron environment)
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'grpc-temp');
  } catch {
    // Fallback to os.tmpdir() if app is not available (e.g., in tests)
    return path.join(os.tmpdir(), 'restura-grpc');
  }
};

const GRPC_TEMP_BASE = getGrpcTempDir();

// Belt-and-braces guard: even though GrpcRequestConfigSchema constrains `id`,
// re-validate at the path.join site to prevent proto-write path traversal in
// case schema constraints are loosened in the future.
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

// Store active calls for streaming with improved management
const activeCalls = new Map<string, ActiveCall>();

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

/**
 * Minimal shape for streaming gRPC call objects. Used to narrow the
 * `unknown` returned by {@link invokeGrpcMethod} before binding event
 * listeners.
 */
type GrpcCall = {
  on: (event: string, listener: (...args: unknown[]) => void) => GrpcCall;
  cancel?: () => void;
  end?: () => void;
  write?: (message: unknown) => void;
};

/**
 * Dynamically invoke a gRPC client method by name.
 *
 * gRPC client method names come from reflection or proto definitions, so
 * they are not statically typed. Previously each call site cast the client
 * to `Record<string, (...args: unknown[]) => unknown>` and indexed into
 * it — which silently invokes `undefined` if the method does not exist,
 * causing the renderer to hang on a never-resolving IPC promise.
 *
 * This helper centralises the dynamic lookup and throws clearly when the
 * method is missing or not callable. The return type is `unknown` because
 * different gRPC method types return different concrete shapes (unary call,
 * readable stream, writable stream, duplex stream); callers narrow with a
 * type guard before binding event listeners.
 */
export function invokeGrpcMethod(client: grpc.Client, method: string, args: unknown[]): unknown {
  const fn = (client as unknown as Record<string, unknown>)[method];
  if (typeof fn !== 'function') {
    throw new Error(`gRPC client has no method "${method}"`);
  }
  return (fn as (...a: unknown[]) => unknown).apply(client, args);
}

/**
 * Type guard for the streaming-call shape returned by
 * {@link invokeGrpcMethod} for streaming method types. Throws if the
 * value does not look like a streaming call so callers do not silently
 * swallow programming errors.
 */
function assertGrpcCall(call: unknown, method: string): asserts call is GrpcCall {
  if (
    typeof call !== 'object' ||
    call === null ||
    typeof (call as { on?: unknown }).on !== 'function'
  ) {
    throw new Error(`gRPC method "${method}" did not return a streaming call object`);
  }
}

// Type guard for gRPC/Connect errors
interface GrpcError {
  name?: string;
  code?: number;
  message?: string;
  details?: string;
}

function isGrpcError(err: unknown): err is GrpcError {
  return (
    typeof err === 'object' && err !== null && ('code' in err || 'message' in err || 'name' in err)
  );
}

function toGrpcError(err: unknown): GrpcError {
  if (isGrpcError(err)) {
    return err;
  }
  if (err instanceof Error) {
    return { message: err.message, name: err.name };
  }
  return { message: String(err) };
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
  const staleIds: string[] = [];

  activeCalls.forEach((call, id) => {
    if (now - call.createdAt > STREAM_TIMEOUT_MS) {
      staleIds.push(id);
      try {
        call.cancel();
      } catch (error) {
        console.error(`Error canceling stale stream ${id}:`, error);
      }
    }
  });

  staleIds.forEach((id) => {
    activeCalls.delete(id);
    console.log(`Cleaned up stale stream: ${id}`);
  });
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
  // Cancel all active streams so we don't block process exit
  activeCalls.forEach((call) => {
    try {
      call.cancel();
    } catch {
      /* ignore */
    }
  });
  activeCalls.clear();
}

// Safe method to add a stream with collision detection
const addActiveCall = (id: string, call: Omit<ActiveCall, 'createdAt' | 'requestId'>): boolean => {
  if (activeCalls.has(id)) {
    console.warn(`Stream with ID ${id} already exists, rejecting duplicate`);
    return false;
  }
  activeCalls.set(id, {
    ...call,
    createdAt: Date.now(),
    requestId: id,
  });
  return true;
};

// Safe method to remove a stream
const removeActiveCall = (id: string): boolean => {
  return activeCalls.delete(id);
};

// Helper to cleanup temp files
const cleanupTemp = (dir: string) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error('Failed to cleanup temp dir:', e);
  }
};

// Clean up old temp directories on startup
export function initializeGrpcTempDir(): void {
  try {
    fs.mkdirSync(GRPC_TEMP_BASE, { recursive: true });

    const entries = fs.readdirSync(GRPC_TEMP_BASE, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(GRPC_TEMP_BASE, entry.name);
        cleanupTemp(dirPath);
      }
    }
  } catch (e) {
    console.error('Failed to initialize gRPC temp directory:', e);
  }
}

// Sanitize proto filename to prevent path traversal
function sanitizeProtoFileName(fileName: string): string {
  // Remove any path separators and get just the base name
  const baseName = path.basename(fileName);
  // Remove any characters that could be problematic
  const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Ensure it ends with .proto
  return sanitized.endsWith('.proto') ? sanitized : `${sanitized}.proto`;
}

function validateProtoContent(content: string): void {
  if (!/^\s*syntax\s*=\s*"proto[23]"/.test(content)) {
    throw new Error('Invalid proto: missing syntax declaration');
  }
  if (!/^service\s+\w+/m.test(content)) {
    throw new Error('Invalid proto: no service definition found');
  }
}

// Helper to load proto
const loadProto = (config: GrpcRequestConfig, tempDir: string) => {
  validateProtoContent(config.protoContent);
  const sanitizedFileName = sanitizeProtoFileName(config.protoFileName || 'service.proto');
  const protoPath = path.join(tempDir, sanitizedFileName);
  fs.writeFileSync(protoPath, config.protoContent);

  const packageDefinition = getProtoLoader().loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  return getGrpc().loadPackageDefinition(packageDefinition);
};

// Build a grpc-js client from the loaded package definition
function buildGrpcClient(
  protoDef: grpc.GrpcObject,
  serviceName: string,
  url: string,
  pinned: GrpcDialAddress,
  useCompression: boolean
): grpc.Client {
  const parts = serviceName.split('.');
  let obj: Record<string, unknown> = protoDef as Record<string, unknown>;
  for (const part of parts) {
    obj = obj[part] as Record<string, unknown>;
    if (!obj) throw new Error(`Service "${serviceName}" not found in proto`);
  }
  if (typeof obj !== 'function') {
    throw new Error(
      `"${serviceName}" resolved to a non-constructor — check the service name in your proto`
    );
  }
  const ServiceClient = obj as unknown as grpc.ServiceClientConstructor;
  // Dial the pre-validated IP literal (not the hostname) so grpc-js's C++
  // resolver can't be rebound between our check and the connect. Authority +
  // SSL target name stay on the original hostname (see computeGrpcDial).
  const { target, useTls, channelOptions: authorityOptions } = computeGrpcDial(url, pinned);
  const grpcLib = getGrpc();
  const credentials = useTls
    ? grpcLib.credentials.createSsl()
    : grpcLib.credentials.createInsecure();
  const channelOptions: grpc.ChannelOptions = {
    ...authorityOptions,
    ...(useCompression
      ? { 'grpc.default_compression_algorithm': 2, 'grpc.default_compression_level': 2 }
      : {}),
  };
  return new ServiceClient(target, credentials, channelOptions);
}

function buildMetadata(map: Record<string, string> = {}): grpc.Metadata {
  const md = new (getGrpc().Metadata)();
  Object.entries(map).forEach(([k, v]) => md.add(k, v));
  return md;
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

async function makeGrpcRequest(config: GrpcRequestConfig): Promise<GrpcResponse> {
  // SSRF pre-flight before any disk I/O or socket open. Failure surfaces as
  // INVALID_ARGUMENT (code 3) with an explicit "[URL policy]" prefix so the
  // renderer can distinguish URL-policy rejections from a gRPC server that
  // legitimately returns INVALID_ARGUMENT for a malformed request body.
  let grpcDial: GrpcDialAddress;
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

  const requestId = config.id && SAFE_GRPC_ID_RE.test(config.id) ? config.id : uuidv4();
  const tempDir = path.join(GRPC_TEMP_BASE, requestId);
  fs.mkdirSync(tempDir, { recursive: true });

  const capturedHeaders: Record<string, string> = {};
  const capturedTrailers: Record<string, string> = {};

  try {
    const protoDef = loadProto(config, tempDir);
    const grpcClient = buildGrpcClient(
      protoDef,
      config.service,
      config.url,
      grpcDial,
      !!config.useCompression
    );
    const metadata = buildMetadata(mergeMainSideAuth(config.metadata, config.auth));
    const method = config.method;

    if (config.methodType === 'unary') {
      try {
        const response = await new Promise<unknown>((resolve, reject) => {
          const call = invokeGrpcMethod(grpcClient, method, [
            config.message,
            metadata,
            (err: grpc.ServiceError | null, res: unknown) => {
              if (err) reject(err);
              else resolve(res);
            },
          ]) as grpc.ClientUnaryCall;
          call.on('metadata', (md: grpc.Metadata) => Object.assign(capturedHeaders, md.getMap()));
          call.on('status', (st: grpc.StatusObject) =>
            Object.assign(capturedTrailers, st.metadata.getMap())
          );
        });
        cleanupTemp(tempDir);
        return {
          status: 0,
          statusText: 'OK',
          headers: capturedHeaders,
          trailers: capturedTrailers,
          message: response,
        };
      } catch (err: unknown) {
        cleanupTemp(tempDir);
        const error = toGrpcError(err);
        return {
          status: error.code || 2,
          statusText: sanitizeErrorMessage(error.message),
          headers: capturedHeaders,
          trailers: capturedTrailers,
          error: sanitizeErrorMessage(error.message),
          details: sanitizeErrorMessage(error.details),
        };
      }
    } else if (config.methodType === 'server-streaming') {
      const messages: unknown[] = [];
      let accumulatedSize = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const callRaw = invokeGrpcMethod(grpcClient, method, [config.message, metadata]);
          assertGrpcCall(callRaw, method);
          const call = callRaw as grpc.ClientReadableStream<unknown>;
          call.on('metadata', (md: grpc.Metadata) => Object.assign(capturedHeaders, md.getMap()));
          call.on('data', (msg: unknown) => {
            accumulatedSize += estimateSize(msg);
            if (accumulatedSize > MAX_RESPONSE_SIZE) {
              call.cancel();
              reject(
                new Error(
                  `Response size exceeded maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`
                )
              );
              return;
            }
            messages.push(msg);
          });
          call.on('status', (st: grpc.StatusObject) =>
            Object.assign(capturedTrailers, st.metadata.getMap())
          );
          call.on('error', (err: Error) => reject(err));
          call.on('end', () => resolve());
        });
        cleanupTemp(tempDir);
        return {
          status: 0,
          statusText: 'OK',
          headers: capturedHeaders,
          trailers: capturedTrailers,
          messages,
        };
      } catch (err: unknown) {
        cleanupTemp(tempDir);
        const error = toGrpcError(err);
        return {
          status: error.code || 2,
          statusText: sanitizeErrorMessage(error.message),
          headers: capturedHeaders,
          trailers: capturedTrailers,
          messages,
          error: sanitizeErrorMessage(error.message),
        };
      }
    } else {
      cleanupTemp(tempDir);
      throw new Error(`Method type ${config.methodType} not supported in synchronous mode`);
    }
  } catch (err: unknown) {
    cleanupTemp(tempDir);
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      status: 2,
      statusText: 'Internal Error',
      headers: {},
      trailers: {},
      error: `gRPC setup failed: ${error.message}`,
    };
  }
}

export function registerGrpcHandlerIPC(onComplete?: (entry: LogEntry) => void): void {
  // Initialize and clean up old temp directories on startup
  initializeGrpcTempDir();

  // Start periodic cleanup of stale streams
  startStreamCleanup();

  ipcMain.handle(
    'grpc:request',
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
    'grpc:start-stream',
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

        // SSRF guard before any cleanup binding or disk I/O so a rejected URL
        // doesn't leave a temp dir or a renderer-destroy listener behind. Resolve
        // + validate + pin the address here (closes the rebind window).
        let grpcDial: GrpcDialAddress;
        try {
          grpcDial = await resolveGrpcDialAddress(config.url);
        } catch (err) {
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
        if (event.sender.isDestroyed()) return;

        bindRendererCleanup(activeCalls, event.sender, (deadId) => {
          disposeByOwner(activeCalls, deadId, (c) => c.cancel());
        });

        const streamStartTime = Date.now();
        const tempDir = path.join(GRPC_TEMP_BASE, requestId);
        fs.mkdirSync(tempDir, { recursive: true });

        try {
          const protoDef = loadProto(config, tempDir);
          const grpcClient = buildGrpcClient(
            protoDef,
            config.service,
            config.url,
            grpcDial,
            !!config.useCompression
          );
          const metadata = buildMetadata(mergeMainSideAuth(config.metadata, config.auth));
          const method = config.method;
          let accumulatedSize = 0;

          const handleData = (data: unknown) => {
            const dataSize = estimateSize(data);
            accumulatedSize += dataSize;

            if (accumulatedSize > MAX_RESPONSE_SIZE) {
              activeCalls.get(requestId)?.cancel();
              event.sender.send(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
                status: 8, // RESOURCE_EXHAUSTED
                details: `Response size exceeded maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`,
              });
              return;
            }

            event.sender.send(eventChannel(EVENT_PREFIX.grpc.data, requestId), data);
          };

          const handleError = (err: unknown) => {
            const error = toGrpcError(err);
            if (error.name === 'AbortError' || error.code === getGrpc().status.CANCELLED) {
              cleanup();
              return;
            }
            event.sender.send(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
              status: error.code || 2,
              details: sanitizeErrorMessage(error.message),
            });
            if (onComplete) {
              onComplete({
                ts: streamStartTime,
                method: `${config.service}/${config.method}`,
                url: config.url,
                status: error.code || 2,
                durationMs: Date.now() - streamStartTime,
                protocol: 'grpc',
                error: sanitizeErrorMessage(error.message),
              });
            }
            cleanup();
          };

          const handleEnd = () => {
            event.sender.send(eventChannel(EVENT_PREFIX.grpc.status, requestId), {
              status: 0,
              details: 'OK',
            });
            if (onComplete) {
              onComplete({
                ts: streamStartTime,
                method: `${config.service}/${config.method}`,
                url: config.url,
                status: 0,
                durationMs: Date.now() - streamStartTime,
                protocol: 'grpc',
              });
            }
            cleanup();
          };

          const cleanup = () => {
            removeActiveCall(requestId);
            cleanupTemp(tempDir);
          };

          if (config.methodType === 'server-streaming') {
            const ssCallRaw = invokeGrpcMethod(grpcClient, method, [config.message, metadata]);
            assertGrpcCall(ssCallRaw, method);
            const ssCall = ssCallRaw as grpc.ClientReadableStream<unknown>;
            ssCall.on('data', handleData);
            ssCall.on('error', handleError);
            ssCall.on('end', handleEnd);

            const added = addActiveCall(requestId, {
              cancel: () => ssCall.cancel(),
              write: () => {},
              end: () => {},
              webContentsId: event.sender.id,
            });

            if (!added) {
              ssCall.cancel();
              event.sender.send(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
                status: 13,
                details: `Stream with ID ${requestId} already exists`,
              });
              return;
            }
          } else if (config.methodType === 'client-streaming') {
            const csCall = invokeGrpcMethod(grpcClient, method, [
              metadata,
              (err: grpc.ServiceError | null, res: unknown) => {
                if (err) {
                  handleError(err);
                } else {
                  handleData(res);
                  handleEnd();
                }
              },
            ]) as grpc.ClientWritableStream<unknown>;

            const csAdded = addActiveCall(requestId, {
              cancel: () => csCall.cancel(),
              write: (msg: unknown) => {
                if (csCall.writableNeedDrain) {
                  console.warn(
                    '[gRPC] Client stream write buffer is full; message queued by kernel — consider slowing the sender'
                  );
                }
                csCall.write(msg);
              },
              end: () => csCall.end(),
              webContentsId: event.sender.id,
            });

            if (!csAdded) {
              csCall.cancel();
              event.sender.send(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
                status: 13,
                details: `Stream with ID ${requestId} already exists`,
              });
              return;
            }
          } else if (config.methodType === 'bidirectional-streaming') {
            const bidiCallRaw = invokeGrpcMethod(grpcClient, method, [metadata]);
            assertGrpcCall(bidiCallRaw, method);
            const bidiCall = bidiCallRaw as grpc.ClientDuplexStream<unknown, unknown>;
            bidiCall.on('data', handleData);
            bidiCall.on('error', handleError);
            bidiCall.on('end', handleEnd);

            const bidiAdded = addActiveCall(requestId, {
              cancel: () => bidiCall.cancel(),
              write: (msg: unknown) => bidiCall.write(msg as object),
              end: () => bidiCall.end(),
              webContentsId: event.sender.id,
            });

            if (!bidiAdded) {
              bidiCall.cancel();
              event.sender.send(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
                status: 13,
                details: `Stream with ID ${requestId} already exists`,
              });
              return;
            }
          }
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          event.sender.send(eventChannel(EVENT_PREFIX.grpc.error, requestId), {
            status: 2,
            details: sanitizeErrorMessage(error.message),
          });
          cleanupTemp(tempDir);
        }
      }
    )
  );

  ipcMain.on(
    'grpc:send-message',
    createValidatedListener(
      IPC.grpc.sendMessage,
      GrpcSendMessageSchema,
      (_event, [requestId, message]) => {
        const call = activeCalls.get(requestId);
        if (call) {
          call.write(message);
        }
      }
    )
  );

  ipcMain.on(
    'grpc:end-stream',
    createValidatedListener(
      IPC.grpc.endStream,
      GrpcStreamRequestIdSchema,
      (_event, requestId: string) => {
        const call = activeCalls.get(requestId);
        if (call) {
          call.end();
        }
      }
    )
  );

  ipcMain.on(
    'grpc:cancel-stream',
    createValidatedListener(
      IPC.grpc.cancelStream,
      GrpcStreamRequestIdSchema,
      (_event, requestId: string) => {
        const call = activeCalls.get(requestId);
        if (call) {
          call.cancel();
          removeActiveCall(requestId); // cleanup immediately; handleError AbortError path also calls cleanup but Map.delete is idempotent
        }
      }
    )
  );
}
