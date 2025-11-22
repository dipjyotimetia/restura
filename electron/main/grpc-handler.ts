import { ipcMain, app } from 'electron';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { createClient } from '@connectrpc/connect';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import {
  GrpcRequestConfigSchema,
  GrpcStreamRequestIdSchema,
  GrpcSendMessageSchema,
  createValidatedHandler,
  createValidatedListener,
  validateIpcInput,
} from './ipc-validators';

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

interface GrpcRequestConfig {
  id?: string; // Request ID for streaming
  url: string;
  service: string;
  method: string;
  methodType: string;
  metadata: Record<string, string>;
  message: unknown;
  protoContent: string;
  protoFileName: string;
}

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
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Failed to cleanup temp dir:', e);
  }
};

// Clean up old temp directories on startup
export function initializeGrpcTempDir(): void {
  try {
    // Ensure base directory exists
    if (!fs.existsSync(GRPC_TEMP_BASE)) {
      fs.mkdirSync(GRPC_TEMP_BASE, { recursive: true });
    }

    // Clean up any existing temp directories from previous sessions
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

// Helper to load proto
const loadProto = (config: GrpcRequestConfig, tempDir: string) => {
  const protoPath = path.join(tempDir, config.protoFileName || 'service.proto');
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

// Create a dynamic service definition for Connect
function createDynamicService(serviceName: string, methodName: string, protoDef: grpc.GrpcObject) {
  const serviceParts = serviceName.split('.');
  let serviceDef: unknown = protoDef;
  for (const part of serviceParts) {
    serviceDef = (serviceDef as Record<string, unknown>)?.[part];
  }
  
  if (!serviceDef || !serviceDef[methodName]) {
    throw new Error(`Method ${methodName} not found in service ${serviceName}`);
  }

  const methodDef = serviceDef[methodName] as grpc.MethodDefinition<unknown, unknown>;
  
  let methodKind = "unary";
  if (methodDef.requestStream && methodDef.responseStream) {
    methodKind = "bidi_streaming";
  } else if (methodDef.requestStream) {
    methodKind = "client_streaming";
  } else if (methodDef.responseStream) {
    methodKind = "server_streaming";
  }

  // Create adapters for Input/Output types using grpc-js serialization
  const InputType = {
    typeName: 'Input', // We don't have the full name easily, but it shouldn't matter for dynamic
    binaryRead: (bytes: Uint8Array) => methodDef.requestDeserialize(Buffer.from(bytes)),
    binaryWrite: (msg: unknown) => methodDef.requestSerialize(msg),
    fromJson: (json: unknown) => json,
    toJson: (msg: unknown) => msg,
    create: (val: unknown) => val || {},
    equals: (a: unknown, b: unknown) => a === b,
    clone: (a: unknown) => ({...(a as object)}),
  };

  const OutputType = {
    typeName: 'Output',
    binaryRead: (bytes: Uint8Array) => methodDef.responseDeserialize(Buffer.from(bytes)),
    binaryWrite: (msg: unknown) => methodDef.responseSerialize(msg),
    fromJson: (json: unknown) => json,
    toJson: (msg: unknown) => msg,
    create: (val: unknown) => val || {},
    equals: (a: unknown, b: unknown) => a === b,
    clone: (a: unknown) => ({...(a as object)}),
  };

  return {
    typeName: serviceName,
    methods: {
      [methodName]: {
        name: methodName,
        I: InputType,
        O: OutputType,
        methodKind: methodKind,
      }
    }
  };
}

async function makeGrpcRequest(config: GrpcRequestConfig): Promise<GrpcResponse> {
  // Use request ID if available, otherwise generate one
  const requestId = config.id || uuidv4();
  const tempDir = path.join(GRPC_TEMP_BASE, requestId);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const protoDef = loadProto(config, tempDir);
    const serviceDef = createDynamicService(config.service, config.method, protoDef);

    // Storage for captured headers and trailers
    const capturedHeaders: Record<string, string> = {};
    const capturedTrailers: Record<string, string> = {};

    // Create interceptor to capture headers and trailers
    const headerInterceptor = (next: any) => async (req: any) => {
      try {
        const response = await next(req);

        // Capture headers from request (these are response headers in Connect)
        if (req.header) {
          req.header.forEach((value: string, key: string) => {
            capturedHeaders[key] = value;
          });
        }

        // Capture trailers from response
        if (response.trailer) {
          response.trailer.forEach((value: string, key: string) => {
            capturedTrailers[key] = value;
          });
        }

        return response;
      } catch (error) {
        // Even on error, try to capture trailers
        if (error && typeof error === 'object' && 'trailer' in error) {
          const err = error as any;
          if (err.trailer) {
            err.trailer.forEach((value: string, key: string) => {
              capturedTrailers[key] = value;
            });
          }
        }
        throw error;
      }
    };

    // Create Connect transport with interceptor
    const transport = createGrpcTransport({
      baseUrl: config.url,
      interceptors: [headerInterceptor],
    });

    const client = createClient(serviceDef as any, transport) as any;

    // Add metadata
    const headers: Record<string, string> = { ...config.metadata };

    const method = config.method;

    if (config.methodType === 'unary') {
      try {
        const response = await client[method](config.message, { headers });

        cleanupTemp(tempDir);
        return {
          status: 0, // OK
          statusText: 'OK',
          headers: capturedHeaders,
          trailers: capturedTrailers,
          message: response
        };
      } catch (err: unknown) {
        cleanupTemp(tempDir);
        const error = err as { code?: number; message?: string; details?: string };
        return {
          status: error.code || 2, // UNKNOWN
          statusText: error.message || 'Unknown Error',
          headers: capturedHeaders,
          trailers: capturedTrailers,
          error: error.message,
          details: error.details
        };
      }
    } else if (config.methodType === 'server-streaming') {
      const messages: unknown[] = [];
      try {
        for await (const response of client[method](config.message, { headers })) {
          messages.push(response);
        }
        cleanupTemp(tempDir);
        return {
          status: 0,
          statusText: 'OK',
          headers: capturedHeaders,
          trailers: capturedTrailers,
          messages
        };
      } catch (err: unknown) {
        cleanupTemp(tempDir);
        const error = err as { code?: number; message?: string; details?: string };
        return {
          status: error.code || 2,
          statusText: error.message,
          headers: capturedHeaders,
          trailers: capturedTrailers,
          messages,
          error: error.message
        };
      }
    } else {
      cleanupTemp(tempDir);
      throw new Error(`Method type ${config.methodType} not supported in unary mode`);
    }

  } catch (err: unknown) {
    cleanupTemp(tempDir);
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      status: 2, // UNKNOWN
      statusText: 'Internal Error',
      headers: {},
      trailers: {},
      error: `gRPC setup failed: ${error.message}`
    };
  }
}



export function registerGrpcHandlerIPC(): void {
  // Initialize and clean up old temp directories on startup
  initializeGrpcTempDir();

  // Start periodic cleanup of stale streams
  startStreamCleanup();

  ipcMain.handle(
    'grpc:request',
    createValidatedHandler('grpc:request', GrpcRequestConfigSchema, async (config: GrpcRequestConfig) => {
      return makeGrpcRequest(config);
    })
  );

  ipcMain.on(
    'grpc:start-stream',
    createValidatedListener('grpc:start-stream', GrpcRequestConfigSchema, (event, config: GrpcRequestConfig) => {
      // Re-implement startGrpcStream with proper signal handling for server streaming
      const requestId = config.id;
      if (!requestId) return;

    const tempDir = path.join(GRPC_TEMP_BASE, requestId);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const protoDef = loadProto(config, tempDir);
      const serviceDef = createDynamicService(config.service, config.method, protoDef);
      
      const transport = createGrpcTransport({
        baseUrl: config.url,
      });

      const client = createClient(serviceDef as any, transport) as any;
      const method = config.method;
      const headers = { ...config.metadata };
      const controller = new AbortController();

      const handleData = (data: unknown) => {
        event.sender.send(`grpc:data:${requestId}`, data);
      };

      const handleError = (err: unknown) => {
        const error = err as { name?: string; code?: number; message?: string };
        if (error.name === 'AbortError') return; // Ignore aborts
        event.sender.send(`grpc:error:${requestId}`, {
          status: error.code || 2,
          details: error.message
        });
        cleanup();
      };

      const handleEnd = () => {
        event.sender.send(`grpc:status:${requestId}`, {
          status: 0,
          details: 'OK'
        });
        cleanup();
      };

      const cleanup = () => {
        removeActiveCall(requestId);
        cleanupTemp(tempDir);
      };

      if (config.methodType === 'server-streaming') {
        (async () => {
          try {
            for await (const response of client[method](config.message, { headers, signal: controller.signal })) {
              handleData(response);
            }
            handleEnd();
          } catch (err) {
            handleError(err);
          }
        })();

        const added = addActiveCall(requestId, {
          cancel: () => controller.abort(),
          write: () => {},
          end: () => {}
        });

        if (!added) {
          event.sender.send(`grpc:error:${requestId}`, {
            status: 13, // INTERNAL
            details: `Stream with ID ${requestId} already exists`
          });
          cleanup();
          return;
        }

      } else if (config.methodType === 'client-streaming' || config.methodType === 'bidirectional-streaming') {
        const inputQueue: unknown[] = [];
        let notifyInput: (() => void) | null = null;
        let finished = false;

        const inputIterable = {
          [Symbol.asyncIterator]: async function* () {
            while (true) {
              if (inputQueue.length > 0) {
                yield inputQueue.shift();
              } else if (finished) {
                return;
              } else {
                await new Promise<void>(resolve => notifyInput = resolve);
                notifyInput = null;
              }
            }
          }
        };

        (async () => {
          try {
            if (config.methodType === 'client-streaming') {
              const response = await client[method](inputIterable, { headers, signal: controller.signal });
              handleData(response);
              handleEnd();
            } else {
              for await (const response of client[method](inputIterable, { headers, signal: controller.signal })) {
                handleData(response);
              }
              handleEnd();
            }
          } catch (err) {
            handleError(err);
          }
        })();

        const added = addActiveCall(requestId, {
          cancel: () => {
            controller.abort();
            finished = true;
            if (notifyInput) notifyInput();
          },
          write: (msg: unknown) => {
            inputQueue.push(msg);
            if (notifyInput) notifyInput();
          },
          end: () => {
            finished = true;
            if (notifyInput) notifyInput();
          }
        });

        if (!added) {
          event.sender.send(`grpc:error:${requestId}`, {
            status: 13, // INTERNAL
            details: `Stream with ID ${requestId} already exists`
          });
          cleanup();
          return;
        }
      }

    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      event.sender.send(`grpc:error:${requestId}`, {
        status: 2,
        details: error.message
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
      }
    })
  );
}
