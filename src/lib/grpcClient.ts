import { createConnectTransport } from '@connectrpc/connect-web';
import type { Transport, Interceptor } from '@connectrpc/connect';
import {
  AuthConfig,
  GrpcRequest,
  GrpcResponse,
  GrpcStatusCode,
  GrpcStatusCodeName,
  ProtoFileInfo,
  ProtoServiceDefinition,
  ProtoMethodDefinition,
  ProtoMessageDefinition,
  ProtoFieldDefinition,
} from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { getElectronAPI, isElectron } from './platform';

// gRPC Client Error
export class GrpcClientError extends Error {
  public statusCode: GrpcStatusCode;
  public details: string;
  public metadata: Record<string, string>;

  constructor(
    message: string,
    statusCode: GrpcStatusCode = GrpcStatusCode.UNKNOWN,
    details: string = '',
    metadata: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'GrpcClientError';
    this.statusCode = statusCode;
    this.details = details;
    this.metadata = metadata;
  }
}

// Auth to Metadata Converter
export function buildAuthMetadata(auth: AuthConfig): Record<string, string> {
  const metadata: Record<string, string> = {};

  switch (auth.type) {
    case 'bearer':
      if (auth.bearer?.token) {
        metadata['authorization'] = `Bearer ${auth.bearer.token}`;
      }
      break;

    case 'basic':
      if (auth.basic?.username && auth.basic?.password) {
        const credentials = btoa(`${auth.basic.username}:${auth.basic.password}`);
        metadata['authorization'] = `Basic ${credentials}`;
      }
      break;

    case 'api-key':
      if (auth.apiKey?.key && auth.apiKey?.value && auth.apiKey.in === 'header') {
        metadata[auth.apiKey.key.toLowerCase()] = auth.apiKey.value;
      }
      break;

    case 'oauth2':
      if (auth.oauth2?.accessToken) {
        const tokenType = auth.oauth2.tokenType || 'Bearer';
        metadata['authorization'] = `${tokenType} ${auth.oauth2.accessToken}`;
      }
      break;

    case 'digest':
      // Digest auth requires challenge-response, not directly applicable to metadata
      // Would need server challenge first
      if (auth.digest?.username && auth.digest?.password) {
        // Store credentials for potential use in interceptor
        metadata['x-digest-username'] = auth.digest.username;
        metadata['x-digest-password'] = auth.digest.password;
      }
      break;

    case 'aws-signature':
      // AWS SigV4 signing requires request details and timestamp
      // This would be handled in an interceptor
      if (auth.awsSignature) {
        metadata['x-aws-access-key'] = auth.awsSignature.accessKey;
        metadata['x-aws-region'] = auth.awsSignature.region;
        metadata['x-aws-service'] = auth.awsSignature.service;
        // Secret key should not be sent in metadata, handled by signing interceptor
      }
      break;

    case 'none':
    default:
      break;
  }

  return metadata;
}

// Create gRPC Interceptor for metadata injection
export function createMetadataInterceptor(metadata: Record<string, string>): Interceptor {
  return (next) => async (req) => {
    // Add metadata to request headers
    Object.entries(metadata).forEach(([key, value]) => {
      req.header.set(key, value);
    });

    return await next(req);
  };
}

// Create timeout interceptor
export function createTimeoutInterceptor(timeoutMs: number): Interceptor {
  return (next) => async (req) => {
    // Set deadline
    req.header.set('grpc-timeout', `${timeoutMs}m`); // milliseconds
    return await next(req);
  };
}

// Proto File Parser (Basic implementation)
export function parseProtoFile(content: string): ProtoFileInfo {
  const lines = content.split('\n');
  const protoInfo: ProtoFileInfo = {
    fileName: '',
    package: '',
    services: [],
    messages: {},
  };

  let currentService: ProtoServiceDefinition | null = null;
  let currentMessage: ProtoMessageDefinition | null = null;
  let braceDepth = 0;
  let inService = false;
  let inMessage = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip comments and empty lines
    if (trimmedLine.startsWith('//') || trimmedLine === '') {
      continue;
    }

    // Parse package
    const packageMatch = trimmedLine.match(/^package\s+([^;]+);/);
    if (packageMatch && packageMatch[1]) {
      protoInfo.package = packageMatch[1].trim();
      continue;
    }

    // Parse service definition
    const serviceMatch = trimmedLine.match(/^service\s+(\w+)\s*\{/);
    if (serviceMatch && serviceMatch[1]) {
      currentService = {
        name: serviceMatch[1],
        fullName: protoInfo.package ? `${protoInfo.package}.${serviceMatch[1]}` : serviceMatch[1],
        methods: [],
      };
      inService = true;
      braceDepth = 1;
      continue;
    }

    // Parse message definition
    const messageMatch = trimmedLine.match(/^message\s+(\w+)\s*\{/);
    if (messageMatch && messageMatch[1] && !inService) {
      currentMessage = {
        name: messageMatch[1],
        fields: [],
      };
      inMessage = true;
      braceDepth = 1;
      continue;
    }

    // Parse RPC method within service
    if (inService && currentService) {
      const rpcMatch = trimmedLine.match(
        /rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s+returns\s+\(\s*(stream\s+)?(\w+)\s*\)/
      );
      if (rpcMatch && rpcMatch[1] && rpcMatch[3] && rpcMatch[5]) {
        const method: ProtoMethodDefinition = {
          name: rpcMatch[1],
          inputType: rpcMatch[3],
          outputType: rpcMatch[5],
          clientStreaming: !!rpcMatch[2],
          serverStreaming: !!rpcMatch[4],
        };
        currentService.methods.push(method);
      }

      // Track braces
      if (trimmedLine.includes('{')) braceDepth++;
      if (trimmedLine.includes('}')) {
        braceDepth--;
        if (braceDepth === 0) {
          protoInfo.services.push(currentService);
          currentService = null;
          inService = false;
        }
      }
    }

    // Parse message fields
    if (inMessage && currentMessage) {
      const fieldMatch = trimmedLine.match(
        /^\s*(repeated\s+)?(optional\s+)?(\w+)\s+(\w+)\s*=\s*(\d+)/
      );
      if (fieldMatch && fieldMatch[3] && fieldMatch[4] && fieldMatch[5]) {
        const field: ProtoFieldDefinition = {
          name: fieldMatch[4],
          type: fieldMatch[3],
          number: parseInt(fieldMatch[5], 10),
          repeated: !!fieldMatch[1],
          optional: !!fieldMatch[2],
        };
        currentMessage.fields.push(field);
      }

      // Track braces
      if (trimmedLine.includes('{')) braceDepth++;
      if (trimmedLine.includes('}')) {
        braceDepth--;
        if (braceDepth === 0) {
          protoInfo.messages[currentMessage.name] = currentMessage;
          currentMessage = null;
          inMessage = false;
        }
      }
    }
  }

  return protoInfo;
}

// Validate gRPC URL format
export function validateGrpcUrl(url: string): { valid: boolean; error?: string } {
  if (!url) {
    return { valid: false, error: 'URL is required' };
  }

  // gRPC-Web typically uses HTTP/HTTPS
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { valid: false, error: 'gRPC-Web URL must start with http:// or https://' };
  }

  try {
    new URL(url);
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

// Validate service name format
export function validateServiceName(service: string): { valid: boolean; error?: string } {
  if (!service) {
    return { valid: false, error: 'Service name is required' };
  }

  // Service name should be in format: package.ServiceName
  const servicePattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.[A-Z][a-zA-Z0-9]*$/;
  if (!servicePattern.test(service)) {
    return {
      valid: false,
      error: 'Service name should be in format: package.ServiceName (e.g., greet.v1.GreetService)',
    };
  }

  return { valid: true };
}

// Validate method name format
export function validateMethodName(method: string): { valid: boolean; error?: string } {
  if (!method) {
    return { valid: false, error: 'Method name is required' };
  }

  // Method name should be PascalCase
  const methodPattern = /^[A-Z][a-zA-Z0-9]*$/;
  if (!methodPattern.test(method)) {
    return { valid: false, error: 'Method name should be PascalCase (e.g., SayHello)' };
  }

  return { valid: true };
}

// Create gRPC Transport
export function createGrpcTransport(
  baseUrl: string,
  metadata: Record<string, string> = {},
  timeoutMs: number = 30000
): Transport {
  const interceptors: Interceptor[] = [];

  // Add metadata interceptor if we have metadata
  if (Object.keys(metadata).length > 0) {
    interceptors.push(createMetadataInterceptor(metadata));
  }

  // Add timeout interceptor
  interceptors.push(createTimeoutInterceptor(timeoutMs));

  return createConnectTransport({
    baseUrl,
    interceptors,
    useBinaryFormat: false, // Use JSON for easier debugging
  });
}

// Convert HTTP status to gRPC status
export function httpStatusToGrpcStatus(httpStatus: number): GrpcStatusCode {
  // Standard HTTP to gRPC status mapping
  // https://github.com/grpc/grpc/blob/master/doc/http-grpc-status-mapping.md
  switch (httpStatus) {
    case 200:
      return GrpcStatusCode.OK;
    case 400:
      return GrpcStatusCode.INVALID_ARGUMENT;
    case 401:
      return GrpcStatusCode.UNAUTHENTICATED;
    case 403:
      return GrpcStatusCode.PERMISSION_DENIED;
    case 404:
      return GrpcStatusCode.NOT_FOUND;
    case 409:
      return GrpcStatusCode.ABORTED;
    case 429:
      return GrpcStatusCode.RESOURCE_EXHAUSTED;
    case 499:
      return GrpcStatusCode.CANCELLED;
    case 500:
      return GrpcStatusCode.INTERNAL;
    case 501:
      return GrpcStatusCode.UNIMPLEMENTED;
    case 503:
      return GrpcStatusCode.UNAVAILABLE;
    case 504:
      return GrpcStatusCode.DEADLINE_EXCEEDED;
    default:
      if (httpStatus >= 200 && httpStatus < 300) {
        return GrpcStatusCode.OK;
      }
      return GrpcStatusCode.UNKNOWN;
  }
}

// Build full gRPC path
export function buildGrpcPath(service: string, method: string): string {
  return `/${service}/${method}`;
}

// Prepare gRPC request with all metadata
export interface PreparedGrpcRequest {
  url: string;
  path: string;
  metadata: Record<string, string>;
  message: unknown;
  methodType: string;
}

export function prepareGrpcRequest(
  request: GrpcRequest,
  resolveVariables: (text: string) => string
): PreparedGrpcRequest {
  // Resolve environment variables in URL
  const resolvedUrl = resolveVariables(request.url);

  // Build metadata from request metadata + auth
  const metadata: Record<string, string> = {};

  // Add user-defined metadata
  request.metadata
    .filter((m) => m.enabled && m.key)
    .forEach((m) => {
      metadata[m.key.toLowerCase()] = resolveVariables(m.value);
    });

  // Add auth metadata (may override user metadata)
  const authMetadata = buildAuthMetadata(request.auth);
  Object.assign(metadata, authMetadata);

  // Parse and validate message
  let parsedMessage: unknown = {};
  if (request.message) {
    try {
      parsedMessage = JSON.parse(resolveVariables(request.message));
    } catch (error) {
      throw new GrpcClientError(
        'Invalid JSON message',
        GrpcStatusCode.INVALID_ARGUMENT,
        'The request message must be valid JSON'
      );
    }
  }

  // Build path
  const path = buildGrpcPath(request.service, request.method);

  return {
    url: resolvedUrl,
    path,
    metadata,
    message: parsedMessage,
    methodType: request.methodType,
  };
}

// Make gRPC request via Electron IPC
export async function makeElectronGrpcRequest(
  request: GrpcRequest,
  protoContent: string,
  protoFileName: string,
  resolveVariables: (text: string) => string
): Promise<GrpcResponse> {
  if (!isElectron()) {
    throw new Error('Electron environment required for full gRPC support');
  }

  const prepared = prepareGrpcRequest(request, resolveVariables);
  const startTime = Date.now();

  try {
    const api = getElectronAPI();
    if (!api) throw new Error('Electron API not available');

    const response = await api.grpc.request({
      url: prepared.url,
      service: request.service,
      method: request.method,
      methodType: request.methodType,
      metadata: prepared.metadata,
      message: prepared.message,
      protoContent,
      protoFileName,
    }) as any; // Cast to any because IPC returns unknown

    const endTime = Date.now();

    const bodyStr = JSON.stringify(response.message || response.messages || {}, null, 2);
    const messagesStrs = response.messages ? response.messages.map((m: unknown) => JSON.stringify(m)) : undefined;

    // Calculate total response size (body + messages if streaming)
    const bodySize = new Blob([bodyStr]).size;
    const messagesSize = messagesStrs
      ? messagesStrs.reduce((acc: number, msg: string) => acc + new Blob([msg]).size, 0)
      : 0;
    const totalSize = bodySize + messagesSize;

    return {
      id: uuidv4(),
      requestId: request.id,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: bodyStr,
      size: totalSize,
      time: endTime - startTime,
      timestamp: Date.now(),
      grpcStatus: response.status,
      grpcStatusText: response.statusText,
      trailers: response.trailers,
      messages: messagesStrs,
      isStreaming: !!response.messages,
    };
  } catch (error: unknown) {
    return createErrorResponse(request.id, error, startTime);
  }
}

// Start gRPC stream via Electron IPC
export function startElectronGrpcStream(
  request: GrpcRequest,
  protoContent: string,
  protoFileName: string,
  resolveVariables: (text: string) => string,
  callbacks: {
    onData: (data: unknown) => void;
    onError: (error: unknown) => void;
    onStatus: (status: unknown) => void;
  }
): {
  sendMessage: (message: unknown) => void;
  endStream: () => void;
  cancelStream: () => void;
} {
  if (!isElectron()) {
    throw new Error('Electron environment required for full gRPC support');
  }

  const api = getElectronAPI();
  if (!api) throw new Error('Electron API not available');

  const prepared = prepareGrpcRequest(request, resolveVariables);
  const requestId = request.id;

  // Setup listeners
  const dataChannel = `grpc:data:${requestId}`;
  const errorChannel = `grpc:error:${requestId}`;
  const statusChannel = `grpc:status:${requestId}`;

  api.grpc.on(dataChannel, callbacks.onData);
  api.grpc.on(errorChannel, callbacks.onError);
  api.grpc.on(statusChannel, callbacks.onStatus);

  // Start stream
  api.grpc.startStream({
    id: requestId,
    url: prepared.url,
    service: request.service,
    method: request.method,
    methodType: request.methodType,
    metadata: prepared.metadata,
    message: prepared.message,
    protoContent,
    protoFileName,
  });

  return {
    sendMessage: (message: unknown) => {
      api.grpc.sendMessage(requestId, message);
    },
    endStream: () => {
      api.grpc.endStream(requestId);
    },
    cancelStream: () => {
      api.grpc.cancelStream(requestId);
      api.grpc.removeListener(dataChannel, callbacks.onData);
      api.grpc.removeListener(errorChannel, callbacks.onError);
      api.grpc.removeListener(statusChannel, callbacks.onStatus);
    }
  };
}

// Create error response
export function createErrorResponse(
  requestId: string,
  error: unknown,
  startTime: number
): GrpcResponse {
  const endTime = Date.now();

  if (error instanceof GrpcClientError) {
    return {
      id: uuidv4(),
      requestId,
      status: error.statusCode,
      statusText: GrpcStatusCodeName[error.statusCode] || 'UNKNOWN',
      headers: {},
      body: JSON.stringify(
        {
          error: error.message,
          details: error.details,
          metadata: error.metadata,
        },
        null,
        2
      ),
      size: 0,
      time: endTime - startTime,
      timestamp: Date.now(),
      grpcStatus: error.statusCode,
      grpcStatusText: GrpcStatusCodeName[error.statusCode] || 'UNKNOWN',
      trailers: {},
    };
  }

  const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

  return {
    id: uuidv4(),
    requestId,
    status: GrpcStatusCode.UNKNOWN,
    statusText: 'UNKNOWN',
    headers: {},
    body: JSON.stringify({ error: errorMessage }, null, 2),
    size: 0,
    time: endTime - startTime,
    timestamp: Date.now(),
    grpcStatus: GrpcStatusCode.UNKNOWN,
    grpcStatusText: 'UNKNOWN',
    trailers: {},
  };
}

// Create success response
export function createSuccessResponse(
  requestId: string,
  responseData: unknown,
  metadata: Record<string, string>,
  trailers: Record<string, string>,
  startTime: number,
  messages?: string[]
): GrpcResponse {
  const endTime = Date.now();
  const bodyString = JSON.stringify(responseData, null, 2);

  return {
    id: uuidv4(),
    requestId,
    status: GrpcStatusCode.OK,
    statusText: 'OK',
    headers: metadata,
    body: bodyString,
    size: new Blob([bodyString]).size,
    time: endTime - startTime,
    timestamp: Date.now(),
    grpcStatus: GrpcStatusCode.OK,
    grpcStatusText: 'OK',
    trailers,
    messages,
    isStreaming: !!messages && messages.length > 1,
  };
}

// Get method type description
export function getMethodTypeDescription(methodType: string): string {
  switch (methodType) {
    case 'unary':
      return 'Unary RPC - Single request, single response';
    case 'server-streaming':
      return 'Server Streaming RPC - Single request, stream of responses';
    case 'client-streaming':
      return 'Client Streaming RPC - Stream of requests, single response';
    case 'bidirectional-streaming':
      return 'Bidirectional Streaming RPC - Stream of requests, stream of responses';
    default:
      return 'Unknown method type';
  }
}

// Format gRPC status for display
export function formatGrpcStatus(statusCode: GrpcStatusCode): string {
  const statusName = GrpcStatusCodeName[statusCode] || 'UNKNOWN';
  return `${statusCode} ${statusName}`;
}

// Check if status indicates error
export function isGrpcError(statusCode: GrpcStatusCode): boolean {
  return statusCode !== GrpcStatusCode.OK;
}

// Get suggested action for error
export function getSuggestedAction(statusCode: GrpcStatusCode): string {
  switch (statusCode) {
    case GrpcStatusCode.UNAUTHENTICATED:
      return 'Check your authentication credentials';
    case GrpcStatusCode.PERMISSION_DENIED:
      return 'Verify you have the required permissions';
    case GrpcStatusCode.NOT_FOUND:
      return 'Verify the service and method names are correct';
    case GrpcStatusCode.INVALID_ARGUMENT:
      return 'Check the request message format and field types';
    case GrpcStatusCode.DEADLINE_EXCEEDED:
      return 'Increase the timeout or check server performance';
    case GrpcStatusCode.UNAVAILABLE:
      return 'Check if the server is running and accessible';
    case GrpcStatusCode.UNIMPLEMENTED:
      return 'This method may not be supported by the server';
    case GrpcStatusCode.INTERNAL:
      return 'Server internal error - check server logs';
    case GrpcStatusCode.RESOURCE_EXHAUSTED:
      return 'Rate limit exceeded - wait before retrying';
    default:
      return 'Check the error details for more information';
  }
}
