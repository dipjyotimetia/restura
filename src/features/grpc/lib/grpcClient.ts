import type {
  AuthConfig,
  GrpcRequest,
  GrpcResponse,
  ProtoFileInfo,
  ProtoServiceDefinition,
  ProtoMessageDefinition,
} from '@/types';
import { GrpcStatusCode, GrpcStatusCodeName } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import {
  getElectronAPI,
  isElectron,
  workerAuthHeaders,
  workerBaseUrl,
} from '@/lib/shared/platform';
import { buildAuthCredential } from '@/features/auth/lib/buildAuthCredential';
import { generateTraceparent } from '@/lib/shared/utils';
import { resolveGrpcTls } from './grpcTls';

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
//
// Common credential shaping (Basic / Bearer / API-Key / OAuth2) is delegated
// to the cross-protocol helper at `features/auth/lib/buildAuthCredential` so
// the gRPC and HTTP code paths can't drift on header construction. The gRPC
// flavour uses lowercase keys (canonical for HTTP/2 metadata) and requires
// BOTH username AND password for Basic auth — both behaviours preserved.
//
// The protocol-specific bits live here: warnings for unsupported types
// (digest, aws-signature). API-key in `query` mode is dropped on the floor
// for gRPC (no URL query string in the metadata frame) — matched by
// returning only `headers`.
export function buildAuthMetadata(auth: AuthConfig): Record<string, string> {
  switch (auth.type) {
    case 'digest':
      // Digest auth requires challenge-response, not directly applicable to gRPC metadata
      // This auth type is not supported for gRPC - use Basic or Bearer auth instead
      console.warn(
        'Digest authentication is not supported for gRPC. Please use Basic or Bearer authentication.'
      );
      return {};

    case 'aws-signature':
      console.warn(
        'AWS Signature authentication is not yet implemented for gRPC. Please use Bearer authentication with an AWS token.'
      );
      return {};

    default: {
      const credential = buildAuthCredential(auth, {
        headerCase: 'lower',
        basicRequiresPassword: true,
      });
      // SecretRef-handle credentials resolve to empty headers here (the renderer
      // can't read handle plaintext). On Electron they're resolved main-side by
      // the gRPC IPC handler — see `grpcAuthNeedsMainSideApply` / the `auth`
      // field threaded into the startStream/request payloads. The web path
      // rejects them up front (handles are desktop-only).
      return { ...credential.headers };
    }
  }
}

/**
 * True when this auth descriptor carries a SecretRef handle the renderer cannot
 * resolve (ADR-0007). Electron threads the descriptor through IPC so the main
 * process resolves it via the OS keychain; web rejects it.
 */
export function grpcAuthNeedsMainSideApply(auth: AuthConfig): boolean {
  return (
    buildAuthCredential(auth, { headerCase: 'lower', basicRequiresPassword: true })
      .requiresMainSideApply === true
  );
}

// Proto File Parser (Basic implementation)
export function parseProtoFile(content: string): ProtoFileInfo {
  // Phase 1: strip comments.
  const noBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const cleanLines = noBlockComments
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trimEnd())
    .filter((line) => line.trim() !== '');

  // Phase 2: normalize logical lines — join multi-line constructs.
  const normalizedLines: string[] = [];
  let i = 0;
  while (i < cleanLines.length) {
    const trimmed = cleanLines[i]!.trim();

    // service/message name with `{` on the next line
    if (/^(service|message)\s+\w+\s*$/.test(trimmed)) {
      let j = i + 1;
      while (j < cleanLines.length && cleanLines[j]!.trim() === '') j++;
      if (j < cleanLines.length && cleanLines[j]!.trim() === '{') {
        normalizedLines.push(trimmed + ' {');
        i = j + 1;
        continue;
      }
    }

    // multi-line rpc — accumulate until returns(Type) is fully matched
    if (trimmed.startsWith('rpc ')) {
      let accumulated = trimmed;
      const rpcComplete = /rpc\s+\w+\s*\([^)]*\)\s+returns\s*\([^)]*\)/;
      let j = i + 1;
      while (!rpcComplete.test(accumulated) && j < cleanLines.length) {
        accumulated += ' ' + cleanLines[j]!.trim();
        j++;
      }
      normalizedLines.push(accumulated);
      i = j;
      continue;
    }

    normalizedLines.push(trimmed);
    i++;
  }

  // Phase 3: parse normalized lines with original state machine.
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

  for (const trimmedLine of normalizedLines) {
    const packageMatch = trimmedLine.match(/^package\s+([^;]+);/);
    if (packageMatch && packageMatch[1]) {
      protoInfo.package = packageMatch[1].trim();
      continue;
    }

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

    if (inService && currentService) {
      const rpcMatch = trimmedLine.match(
        /rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s+returns\s+\(\s*(stream\s+)?(\w+)\s*\)/
      );
      if (rpcMatch && rpcMatch[1] && rpcMatch[3] && rpcMatch[5]) {
        currentService.methods.push({
          name: rpcMatch[1],
          inputType: rpcMatch[3],
          outputType: rpcMatch[5],
          clientStreaming: !!rpcMatch[2],
          serverStreaming: !!rpcMatch[4],
        });
      }

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

    if (inMessage && currentMessage) {
      const fieldMatch = trimmedLine.match(
        /^\s*(repeated\s+)?(optional\s+)?(\w+)\s+(\w+)\s*=\s*(\d+)/
      );
      if (fieldMatch && fieldMatch[3] && fieldMatch[4] && fieldMatch[5]) {
        currentMessage.fields.push({
          name: fieldMatch[4],
          type: fieldMatch[3],
          number: parseInt(fieldMatch[5], 10),
          repeated: !!fieldMatch[1],
          optional: !!fieldMatch[2],
        });
      }

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

  if (!metadata['traceparent']) {
    metadata['traceparent'] = generateTraceparent();
  }

  // Add auth metadata (may override user metadata)
  const authMetadata = buildAuthMetadata(request.auth);
  Object.assign(metadata, authMetadata);

  // Validate metadata size limits
  const MAX_METADATA_SIZE = 8 * 1024; // 8KB total
  const MAX_HEADER_SIZE = 1024; // 1KB per header
  let totalSize = 0;

  for (const [key, value] of Object.entries(metadata)) {
    const headerSize = key.length + value.length;
    if (headerSize > MAX_HEADER_SIZE) {
      throw new GrpcClientError(
        `Metadata header '${key}' exceeds maximum size of ${MAX_HEADER_SIZE} bytes`,
        GrpcStatusCode.INVALID_ARGUMENT,
        'Reduce the size of metadata headers'
      );
    }
    totalSize += headerSize;
  }

  if (totalSize > MAX_METADATA_SIZE) {
    throw new GrpcClientError(
      `Total metadata size (${totalSize} bytes) exceeds maximum of ${MAX_METADATA_SIZE} bytes`,
      GrpcStatusCode.INVALID_ARGUMENT,
      'Reduce the number or size of metadata headers'
    );
  }

  // Parse and validate message
  let parsedMessage: unknown = {};
  if (request.message) {
    try {
      parsedMessage = JSON.parse(resolveVariables(request.message));
    } catch {
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
  resolveVariables: (text: string) => string,
  timeoutMs: number = 30000,
  useCompression: boolean = false,
  // Base64 binary FileDescriptorProtos from reflection. When present the main
  // process loads the complete descriptor set (lossless) and ignores the
  // reconstructed `protoContent` text.
  descriptors?: string[]
): Promise<GrpcResponse> {
  if (!isElectron()) {
    throw new Error('Electron environment required for full gRPC support');
  }

  const prepared = prepareGrpcRequest(request, resolveVariables);
  const startTime = Date.now();

  try {
    const api = getElectronAPI();
    if (!api) throw new Error('Electron API not available');

    // Per-host TLS trust / mTLS material so a self-signed / private-CA / mTLS
    // gRPC server connects instead of failing the handshake.
    const tls = resolveGrpcTls(prepared.url);

    const response = await api.grpc.request({
      url: prepared.url,
      service: request.service,
      method: request.method,
      methodType: request.methodType,
      metadata: prepared.metadata,
      message: prepared.message,
      protoContent,
      protoFileName,
      ...(descriptors?.length ? { descriptors } : {}),
      timeoutMs,
      useCompression,
      // Hand the descriptor to the main process only when it holds a handle the
      // renderer couldn't resolve; inline/plain creds are already in `metadata`.
      ...(grpcAuthNeedsMainSideApply(request.auth) ? { auth: request.auth } : {}),
      // resolveGrpcTls already omits absent keys, so spread it whole.
      ...(tls ?? {}),
    });

    const endTime = Date.now();

    const bodyStr = JSON.stringify(response.message || response.messages || {}, null, 2);
    const messagesStrs = response.messages
      ? response.messages.map((m: unknown) => JSON.stringify(m))
      : undefined;

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

// gRPC streaming is driven by startGrpcStream() in grpcStreamingClient.ts —
// a single async-iterator path for web (connect-fetch) and Electron (IPC →
// grpc-js). The former callback-based startElectronGrpcStream was removed in
// favour of that unified handle.

// Create error response
export function createErrorResponse(
  requestId: string,
  error: unknown,
  startTime: number
): GrpcResponse {
  const endTime = Date.now();

  if (error instanceof GrpcClientError) {
    const errorBody = JSON.stringify(
      {
        error: error.message,
        details: error.details,
        metadata: error.metadata,
      },
      null,
      2
    );
    return {
      id: uuidv4(),
      requestId,
      status: error.statusCode,
      statusText: GrpcStatusCodeName[error.statusCode] || 'UNKNOWN',
      headers: {},
      body: errorBody,
      size: new Blob([errorBody]).size,
      time: endTime - startTime,
      timestamp: Date.now(),
      grpcStatus: error.statusCode,
      grpcStatusText: GrpcStatusCodeName[error.statusCode] || 'UNKNOWN',
      trailers: {},
    };
  }

  const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
  const errorBody = JSON.stringify({ error: errorMessage }, null, 2);

  return {
    id: uuidv4(),
    requestId,
    status: GrpcStatusCode.UNKNOWN,
    statusText: 'UNKNOWN',
    headers: {},
    body: errorBody,
    size: new Blob([errorBody]).size,
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

// Make gRPC request via server proxy
export async function makeProxyGrpcRequest(
  request: GrpcRequest,
  resolveVariables: (text: string) => string,
  timeoutMs: number = 30000
): Promise<GrpcResponse> {
  // Handle-backed secrets can only be resolved in the Electron main process
  // (OS keychain); the Worker proxy has no access. Fail fast with a clear cause
  // instead of silently sending an unauthenticated request that 401s upstream.
  if (grpcAuthNeedsMainSideApply(request.auth)) {
    return createErrorResponse(
      request.id,
      new GrpcClientError(
        'This credential uses a stored secret handle, which is only available in the Restura desktop app. ' +
          'Switch the credential to an inline value to use it on the web.',
        GrpcStatusCode.UNAUTHENTICATED
      ),
      Date.now()
    );
  }

  const prepared = prepareGrpcRequest(request, resolveVariables);
  const startTime = Date.now();

  try {
    const response = await fetch(`${workerBaseUrl()}/api/grpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...workerAuthHeaders(),
      },
      body: JSON.stringify({
        url: prepared.url,
        service: request.service,
        method: request.method,
        metadata: prepared.metadata,
        message: prepared.message,
        timeout: timeoutMs,
      }),
    });

    const result = await response.json();
    const endTime = Date.now();

    const bodyStr = JSON.stringify(result.data || {}, null, 2);

    return {
      id: uuidv4(),
      requestId: request.id,
      status: result.grpcStatus,
      statusText: result.grpcStatusText,
      headers: result.headers || {},
      body: bodyStr,
      size: result.size || new Blob([bodyStr]).size,
      time: endTime - startTime,
      timestamp: Date.now(),
      grpcStatus: result.grpcStatus,
      grpcStatusText: result.grpcStatusText,
      trailers: result.trailers || {},
    };
  } catch (error: unknown) {
    return createErrorResponse(request.id, error, startTime);
  }
}
