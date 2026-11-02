import { FieldDescriptorProto_Type } from '@bufbuild/protobuf/wkt';
import { normalizeProtoPath } from '@shared/protocol/grpc-proto-compiler';
import {
  listServices,
  registryFromDescriptors,
  registryFromProtoText,
} from '@shared/protocol/grpc-registry';
import {
  grpcMetadataSizeError,
  grpcUnsupportedAuthMessage as sharedGrpcUnsupportedAuthMessage,
} from '@shared/protocol/grpc-request-policy';
import { GRPC_PROXY_MAX_TIMEOUT_MS } from '@shared/protocol/grpc-schema';
import {
  type GrpcStatusDetail,
  redecodeRawStatusDetails,
} from '@shared/protocol/grpc-status-details';
import { MAX_GRPC_METADATA_BYTES } from '@shared/protocol/header-policy';
import { v4 as uuidv4 } from 'uuid';
import { buildAuthCredential } from '@/features/auth/lib/buildAuthCredential';
import {
  getElectronAPI,
  isElectron,
  workerAuthHeaders,
  workerBaseUrl,
} from '@/lib/shared/platform';
import { generateTraceparent } from '@/lib/shared/utils';
import type {
  AuthConfig,
  GrpcRequest,
  GrpcResponse,
  GrpcWireProtocol,
  ProtoFileInfo,
  ProtoMessageDefinition,
  ProtoServiceDefinition,
} from '@/types';
import { GrpcStatusCode, GrpcStatusCodeName } from '@/types';
import { resolveGrpcTls } from './grpcTls';

export { MAX_GRPC_METADATA_BYTES };

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

/**
 * The Worker relays (`/api/grpc`, `/api/grpc-web`) reject deadlines above
 * GRPC_PROXY_MAX_TIMEOUT_MS with a late HTTP 400; fail fast client-side instead.
 * 0 (no deadline) is allowed through.
 */
export function assertProxyDeadline(timeoutMs: number): void {
  if (timeoutMs > GRPC_PROXY_MAX_TIMEOUT_MS) {
    throw new GrpcClientError(
      `The web proxy supports deadlines up to ${GRPC_PROXY_MAX_TIMEOUT_MS / 1000}s; ` +
        `${timeoutMs / 1000}s is too long. Lower the deadline or use the desktop app.`,
      GrpcStatusCode.INVALID_ARGUMENT
    );
  }
}

/**
 * User-facing reason a gRPC call can't apply this auth (#900), or `null` when
 * the auth type is supported. The policy lives in
 * `shared/protocol/grpc-request-policy.ts` so the CLI enforces the same block.
 */
export function grpcUnsupportedAuthMessage(auth: AuthConfig): string | null {
  return sharedGrpcUnsupportedAuthMessage(auth);
}

// Auth to Metadata Converter
//
// Common credential shaping (Basic / Bearer / API-Key / OAuth2) is delegated
// to the cross-protocol helper at `features/auth/lib/buildAuthCredential` so
// the gRPC and HTTP code paths can't drift on header construction. The gRPC
// flavour uses lowercase keys (canonical for HTTP/2 metadata) and requires
// BOTH username AND password for Basic auth — both behaviours preserved.
//
// Sign-at-wire / challenge types (`GRPC_UNSUPPORTED_AUTH`, shared policy) produce no
// metadata; `prepareGrpcRequest` blocks the send for them instead. API-key in
// `query` mode is dropped on the floor for gRPC (no URL query string in the
// metadata frame) — matched by returning only `headers`.
export function buildAuthMetadata(auth: AuthConfig): Record<string, string> {
  if (grpcUnsupportedAuthMessage(auth)) return {};
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

/**
 * Human-readable preview of the auth metadata a gRPC call will carry, with
 * credential values truncated. Unsupported auth types (#900) explain why
 * nothing is sent instead of claiming no auth is configured.
 */
export function describeGrpcAuthMetadata(auth: AuthConfig): string {
  const unsupported = grpcUnsupportedAuthMessage(auth);
  if (unsupported) return unsupported;
  const authMetadata = buildAuthMetadata(auth);
  if (Object.keys(authMetadata).length === 0) return 'No authentication configured';
  return Object.entries(authMetadata)
    .map(([key, value]) => {
      const maskedValue =
        key.includes('authorization') || key.includes('password')
          ? `${value.substring(0, 10)}...`
          : value;
      return `${key}: ${maskedValue}`;
    })
    .join('\n');
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

/**
 * The wire protocol to pin on the desktop IPC path. grpc-web-text is web-only
 * (connect-node implements binary gRPC-Web only).
 */
export function desktopWireProtocol(
  wire: GrpcWireProtocol | undefined
): Exclude<GrpcWireProtocol, 'grpc-web-text'> | undefined {
  if (wire === 'grpc-web-text') {
    throw new GrpcClientError(
      'gRPC-Web text mode is available on the web app only. Use binary gRPC-Web on desktop.',
      GrpcStatusCode.UNIMPLEMENTED
    );
  }
  return wire;
}

/** Error for wire protocols the web app cannot speak, else null. */
export function webWireProtocolError(wire: GrpcWireProtocol | undefined): GrpcClientError | null {
  if (wire !== 'grpc') return null;
  return new GrpcClientError(
    'Native gRPC (HTTP/2 trailers) needs the Restura desktop app. On the web, choose gRPC-Web or Connect.',
    GrpcStatusCode.UNIMPLEMENTED
  );
}

// Proto file → service/method/message summary (#905). Read off the real
// descriptors (shared registry, same compiler the call path uses) rather than a
// regex over the text, so package-qualified (`google.protobuf.Empty`), nested
// (`Outer.Inner`) and leading-dot (`.pkg.Type`) references are all listed and
// type names come back fully qualified. A schema that can't be compiled (e.g.
// an import that wasn't uploaded) throws instead of silently dropping RPCs.
export function parseProtoFile(content: string, fileName = 'schema.proto'): ProtoFileInfo {
  const registry = registryFromProtoText(content, fileName);
  // bufbuild's DescFile.name is the normalized path without `.proto`.
  const fileStem = (normalizeProtoPath(fileName) || 'schema.proto').replace(/\.proto$/, '');
  const messages: Record<string, ProtoMessageDefinition> = {};
  let pkg = '';
  for (const desc of registry) {
    if (desc.kind !== 'message' || desc.file.name !== fileStem || desc.parent) continue;
    pkg = desc.file.proto.package;
    messages[desc.name] = {
      name: desc.name,
      fields: desc.fields.map((f) => ({
        name: f.name,
        type:
          f.message?.typeName ??
          f.enum?.typeName ??
          FieldDescriptorProto_Type[f.proto.type].replace(/^TYPE_/, '').toLowerCase(),
        number: f.number,
        repeated: f.fieldKind === 'list',
        optional: f.proto.proto3Optional,
      })),
    };
  }
  const services: ProtoServiceDefinition[] = listServices(registry);
  const firstService = services[0];
  if (!pkg && firstService) {
    pkg = firstService.fullName.slice(0, Math.max(0, firstService.fullName.lastIndexOf('.')));
  }
  return { fileName, package: pkg, services, messages };
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
  // Block auth types gRPC can't apply rather than sending unauthenticated
  // (#900). Every harness (Electron IPC, web proxy, web streaming) prepares
  // through here, so this is the single choke point.
  const unsupportedAuth = grpcUnsupportedAuthMessage(request.auth);
  if (unsupportedAuth) {
    throw new GrpcClientError(
      unsupportedAuth,
      GrpcStatusCode.FAILED_PRECONDITION,
      'Choose a gRPC-compatible auth type'
    );
  }

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

  // Validate the aggregate metadata size (#895) — shared policy with the CLI.
  const metadataSizeError = grpcMetadataSizeError(metadata);
  if (metadataSizeError) {
    throw new GrpcClientError(
      metadataSizeError,
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
    const wireProtocol = desktopWireProtocol(request.wireProtocol);
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
      ...(wireProtocol ? { wireProtocol } : {}),
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
      ...(response.statusDetails?.length ? { statusDetails: response.statusDetails } : {}),
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
  const wireError = webWireProtocolError(request.wireProtocol);
  if (wireError) return createErrorResponse(request.id, wireError, Date.now());
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

  try {
    assertProxyDeadline(timeoutMs);
  } catch (e) {
    return createErrorResponse(request.id, e, Date.now());
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
      ...(Array.isArray(result.statusDetails) && result.statusDetails.length > 0
        ? { statusDetails: decodeWithSchema(result.statusDetails, request.schema) }
        : {}),
    };
  } catch (error: unknown) {
    return createErrorResponse(request.id, error, startTime);
  }
}

// The proxy has no schema, so custom detail types arrive as `{ type, raw }`;
// decode the ones the request's loaded schema defines.
function decodeWithSchema(
  details: GrpcStatusDetail[],
  schema: GrpcRequest['schema']
): GrpcStatusDetail[] {
  if (!schema || !details.some((d) => d.raw !== undefined)) return details;
  try {
    const registry =
      schema.kind === 'descriptors'
        ? registryFromDescriptors(schema.descriptors)
        : registryFromProtoText(schema.text);
    return redecodeRawStatusDetails(details, registry);
  } catch {
    return details; // a schema that doesn't build just keeps the raw rendering
  }
}
