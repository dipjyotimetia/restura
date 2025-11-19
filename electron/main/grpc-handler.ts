import { ipcMain } from 'electron';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { createClient } from '@connectrpc/connect';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';

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
}

// Store active calls for streaming
const activeCalls = new Map<string, ActiveCall>();

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
  const tempDir = path.join(os.tmpdir(), 'restura-grpc', uuidv4());
  fs.mkdirSync(tempDir, { recursive: true });
  
  try {
    const protoDef = loadProto(config, tempDir);
    const serviceDef = createDynamicService(config.service, config.method, protoDef);
    
    // Create Connect transport
    // We use useBinaryFormat: true because we are using the grpc-js serializers which produce binary
    // But wait, if we use binaryWrite, we are producing binary.
    // If we use useBinaryFormat: false (JSON), Connect will use toJson/fromJson.
    // Since our toJson/fromJson are identity, it will send the raw message object as JSON.
    // This is good for Connect protocol or gRPC-JSON transcoding.
    // But for standard gRPC, we MUST use binary.
    // So we should use useBinaryFormat: true (default).
    const transport = createGrpcTransport({
      baseUrl: config.url,
      interceptors: [],
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
          headers: {}, // TODO: Extract headers from response
          trailers: {},
          message: response
        };
      } catch (err: unknown) {
        cleanupTemp(tempDir);
        const error = err as { code?: number; message?: string; details?: string };
        return {
          status: error.code || 2, // UNKNOWN
          statusText: error.message || 'Unknown Error',
          headers: {},
          trailers: {},
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
          headers: {},
          trailers: {},
          messages
        };
      } catch (err: unknown) {
        cleanupTemp(tempDir);
        const error = err as { code?: number; message?: string; details?: string };
        return {
          status: error.code || 2,
          statusText: error.message,
          headers: {},
          trailers: {},
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
  ipcMain.handle('grpc:request', async (_event, config: GrpcRequestConfig) => {
    return makeGrpcRequest(config);
  });

  ipcMain.on('grpc:start-stream', (event, config: GrpcRequestConfig) => {
    // Re-implement startGrpcStream with proper signal handling for server streaming
    const requestId = config.id;
    if (!requestId) return;

    const tempDir = path.join(os.tmpdir(), 'restura-grpc', requestId);
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
        if (activeCalls.has(requestId)) {
          activeCalls.delete(requestId);
          cleanupTemp(tempDir);
        }
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

        activeCalls.set(requestId, {
          cancel: () => controller.abort(),
          write: () => {},
          end: () => {}
        });

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

        activeCalls.set(requestId, {
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
      }

    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      event.sender.send(`grpc:error:${requestId}`, {
        status: 2,
        details: error.message
      });
      cleanupTemp(tempDir);
    }
  });

  ipcMain.on('grpc:send-message', (_event, requestId: string, message: unknown) => {
    const call = activeCalls.get(requestId);
    if (call) {
      call.write(message);
    }
  });

  ipcMain.on('grpc:end-stream', (_event, requestId: string) => {
    const call = activeCalls.get(requestId);
    if (call) {
      call.end();
    }
  });

  ipcMain.on('grpc:cancel-stream', (_event, requestId: string) => {
    const call = activeCalls.get(requestId);
    if (call) {
      call.cancel();
    }
  });
}
