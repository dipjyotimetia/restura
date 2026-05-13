import { ipcMain, app } from 'electron';
import type { LogEntry } from './request-logger';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type {
  GrpcRequestConfig} from './ipc-validators';
import {
  GrpcRequestConfigSchema,
  GrpcStreamRequestIdSchema,
  GrpcSendMessageSchema,
  createValidatedHandler,
  createValidatedListener
} from './ipc-validators';
import { createKeyedRateLimiter, rateLimited } from './ipc-rate-limiter';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';

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

// Type guard for gRPC/Connect errors
interface GrpcError {
  name?: string;
  code?: number;
  message?: string;
  details?: string;
}

function isGrpcError(err: unknown): err is GrpcError {
  return (
    typeof err === 'object' &&
    err !== null &&
    ('code' in err || 'message' in err || 'name' in err)
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
  activeCalls.forEach((call) => { try { call.cancel(); } catch { /* ignore */ } });
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

  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  return grpc.loadPackageDefinition(packageDefinition);
};

// Build a grpc-js client from the loaded package definition
function buildGrpcClient(
  protoDef: grpc.GrpcObject,
  serviceName: string,
  url: string,
  useCompression: boolean
): grpc.Client {
  const parts = serviceName.split('.');
  let obj: Record<string, unknown> = protoDef as Record<string, unknown>;
  for (const part of parts) {
    obj = obj[part] as Record<string, unknown>;
    if (!obj) throw new Error(`Service "${serviceName}" not found in proto`);
  }
  if (typeof obj !== 'function') {
    throw new Error(`"${serviceName}" resolved to a non-constructor — check the service name in your proto`);
  }
  const ServiceClient = obj as unknown as typeof grpc.Client;
  const target = url.replace(/^https?:\/\//, '');
  const credentials = url.startsWith('https://')
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();
  const channelOptions: grpc.ChannelOptions = useCompression
    ? { 'grpc.default_compression_algorithm': 2, 'grpc.default_compression_level': 2 }
    : {};
  return new ServiceClient(target, credentials, channelOptions);
}

function buildMetadata(map: Record<string, string> = {}): grpc.Metadata {
  const md = new grpc.Metadata();
  Object.entries(map).forEach(([k, v]) => md.add(k, v));
  return md;
}

async function makeGrpcRequest(config: GrpcRequestConfig): Promise<GrpcResponse> {
  const requestId = config.id && SAFE_GRPC_ID_RE.test(config.id) ? config.id : uuidv4();
  const tempDir = path.join(GRPC_TEMP_BASE, requestId);
  fs.mkdirSync(tempDir, { recursive: true });

  const capturedHeaders: Record<string, string> = {};
  const capturedTrailers: Record<string, string> = {};

  try {
    const protoDef = loadProto(config, tempDir);
    const grpcClient = buildGrpcClient(protoDef, config.service, config.url, !!config.useCompression);
    const metadata = buildMetadata(config.metadata);
    const method = config.method;

    if (config.methodType === 'unary') {
      try {
        const response = await new Promise<unknown>((resolve, reject) => {
          const call = (grpcClient as unknown as Record<string, (...args: unknown[]) => unknown>)[method](
            config.message,
            metadata,
            (err: grpc.ServiceError | null, res: unknown) => { if (err) reject(err); else resolve(res); }
          ) as grpc.ClientUnaryCall;
          call.on('metadata', (md: grpc.Metadata) => Object.assign(capturedHeaders, md.getMap()));
          call.on('status', (st: grpc.StatusObject) => Object.assign(capturedTrailers, st.metadata.getMap()));
        });
        cleanupTemp(tempDir);
        return { status: 0, statusText: 'OK', headers: capturedHeaders, trailers: capturedTrailers, message: response };
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
          const call = (grpcClient as unknown as Record<string, (...args: unknown[]) => unknown>)[method](
            config.message,
            metadata
          ) as grpc.ClientReadableStream<unknown>;
          call.on('metadata', (md: grpc.Metadata) => Object.assign(capturedHeaders, md.getMap()));
          call.on('data', (msg: unknown) => {
            accumulatedSize += estimateSize(msg);
            if (accumulatedSize > MAX_RESPONSE_SIZE) {
              call.cancel();
              reject(new Error(`Response size exceeded maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`));
              return;
            }
            messages.push(msg);
          });
          call.on('status', (st: grpc.StatusObject) => Object.assign(capturedTrailers, st.metadata.getMap()));
          call.on('error', (err: Error) => reject(err));
          call.on('end', () => resolve());
        });
        cleanupTemp(tempDir);
        return { status: 0, statusText: 'OK', headers: capturedHeaders, trailers: capturedTrailers, messages };
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
      createValidatedHandler('grpc:request', GrpcRequestConfigSchema, async (config: GrpcRequestConfig) => {
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
      })
    )
  );

  ipcMain.on(
    'grpc:start-stream',
    createValidatedListener('grpc:start-stream', GrpcRequestConfigSchema, (event, config: GrpcRequestConfig) => {
      const requestId = config.id;
      if (!requestId || !SAFE_GRPC_ID_RE.test(requestId)) return;

      if (!grpcRateLimiter.check(event.sender.id)) {
        event.sender.send(`grpc:error:${requestId}`, {
          status: 14,
          details: 'Rate limit exceeded'
        });
        return;
      }

    const streamStartTime = Date.now();
    const tempDir = path.join(GRPC_TEMP_BASE, requestId);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const protoDef = loadProto(config, tempDir);
      const grpcClient = buildGrpcClient(protoDef, config.service, config.url, !!config.useCompression);
      const metadata = buildMetadata(config.metadata);
      const method = config.method;
      let accumulatedSize = 0;

      const handleData = (data: unknown) => {
        const dataSize = estimateSize(data);
        accumulatedSize += dataSize;

        if (accumulatedSize > MAX_RESPONSE_SIZE) {
          activeCalls.get(requestId)?.cancel();
          event.sender.send(`grpc:error:${requestId}`, {
            status: 8, // RESOURCE_EXHAUSTED
            details: `Response size exceeded maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`
          });
          return;
        }

        event.sender.send(`grpc:data:${requestId}`, data);
      };

      const handleError = (err: unknown) => {
        const error = toGrpcError(err);
        if (error.name === 'AbortError' || error.code === grpc.status.CANCELLED) {
          cleanup();
          return;
        }
        event.sender.send(`grpc:error:${requestId}`, {
          status: error.code || 2,
          details: sanitizeErrorMessage(error.message)
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
        event.sender.send(`grpc:status:${requestId}`, {
          status: 0,
          details: 'OK'
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
        const ssCall = (grpcClient as unknown as Record<string, (...args: unknown[]) => unknown>)[method](
          config.message, metadata
        ) as grpc.ClientReadableStream<unknown>;
        ssCall.on('data', handleData);
        ssCall.on('error', handleError);
        ssCall.on('end', handleEnd);

        const added = addActiveCall(requestId, {
          cancel: () => ssCall.cancel(),
          write: () => {},
          end: () => {}
        });

        if (!added) {
          ssCall.cancel();
          event.sender.send(`grpc:error:${requestId}`, {
            status: 13,
            details: `Stream with ID ${requestId} already exists`
          });
          return;
        }

      } else if (config.methodType === 'client-streaming') {
        const csCall = (grpcClient as unknown as Record<string, (...args: unknown[]) => unknown>)[method](
          metadata,
          (err: grpc.ServiceError | null, res: unknown) => {
            if (err) {
              handleError(err);
            } else {
              handleData(res);
              handleEnd();
            }
          }
        ) as grpc.ClientWritableStream<unknown>;

        const csAdded = addActiveCall(requestId, {
          cancel: () => csCall.cancel(),
          write: (msg: unknown) => {
            if (csCall.writableNeedDrain) {
              console.warn('[gRPC] Client stream write buffer is full; message queued by kernel — consider slowing the sender');
            }
            csCall.write(msg);
          },
          end: () => csCall.end()
        });

        if (!csAdded) {
          csCall.cancel();
          event.sender.send(`grpc:error:${requestId}`, {
            status: 13,
            details: `Stream with ID ${requestId} already exists`
          });
          return;
        }

      } else if (config.methodType === 'bidirectional-streaming') {
        const bidiCall = (grpcClient as unknown as Record<string, (...args: unknown[]) => unknown>)[method](
          metadata
        ) as grpc.ClientDuplexStream<unknown, unknown>;
        bidiCall.on('data', handleData);
        bidiCall.on('error', handleError);
        bidiCall.on('end', handleEnd);

        const bidiAdded = addActiveCall(requestId, {
          cancel: () => bidiCall.cancel(),
          write: (msg: unknown) => bidiCall.write(msg as object),
          end: () => bidiCall.end()
        });

        if (!bidiAdded) {
          bidiCall.cancel();
          event.sender.send(`grpc:error:${requestId}`, {
            status: 13,
            details: `Stream with ID ${requestId} already exists`
          });
          return;
        }
      }

    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      event.sender.send(`grpc:error:${requestId}`, {
        status: 2,
        details: sanitizeErrorMessage(error.message)
      });
      cleanupTemp(tempDir);
    }
    })
  );

  ipcMain.on(
    'grpc:send-message',
    createValidatedListener('grpc:send-message', GrpcSendMessageSchema, (_event, [requestId, message]) => {
      const call = activeCalls.get(requestId);
      if (call) {
        call.write(message);
      }
    })
  );

  ipcMain.on(
    'grpc:end-stream',
    createValidatedListener('grpc:end-stream', GrpcStreamRequestIdSchema, (_event, requestId: string) => {
      const call = activeCalls.get(requestId);
      if (call) {
        call.end();
      }
    })
  );

  ipcMain.on(
    'grpc:cancel-stream',
    createValidatedListener('grpc:cancel-stream', GrpcStreamRequestIdSchema, (_event, requestId: string) => {
      const call = activeCalls.get(requestId);
      if (call) {
        call.cancel();
        removeActiveCall(requestId); // cleanup immediately; handleError AbortError path also calls cleanup but Map.delete is idempotent
      }
    })
  );
}
