/**
 * Web/self-host gRPC-Web client (#914).
 *
 * The Worker's `/api/grpc-web` route is schema-less: this module owns the
 * schema half — it encodes the editor JSON to protobuf binary with the runtime
 * descriptor registry (reflection descriptors or uploaded `.proto`), posts it
 * to the Worker, reads the NDJSON event stream back (headers → message* →
 * end) and decodes each message to JSON. Wire framing, SSRF, header policy and
 * size caps live in `shared/protocol/grpc-web-proxy.ts`.
 */

import { type DescMethod, fromBinary, type Registry, toBinary } from '@bufbuild/protobuf';
import {
  callKindOf,
  inputFromJson,
  outputToJson,
  registryFromDescriptors,
  registryFromProtoText,
  resolveMethod,
} from '@shared/protocol/grpc-registry';
import { base64ToBytes, bytesToBase64 } from '@shared/protocol/grpc-web-framing';
import type { GrpcWebEndEvent, GrpcWebEvent, GrpcWebSpec } from '@shared/protocol/grpc-web-proxy';
import { NdjsonParser } from '@shared/protocol/ndjson-parser';
import { v4 as uuidv4 } from 'uuid';
import { isElectron, workerAuthHeaders, workerBaseUrl } from '@/lib/shared/platform';
import type { GrpcRequest, GrpcResponse, GrpcSchemaSnapshot, GrpcWireProtocol } from '@/types';
import { GrpcStatusCode, GrpcStatusCodeName } from '@/types';
import {
  createErrorResponse,
  assertProxyDeadline,
  GrpcClientError,
  grpcAuthNeedsMainSideApply,
  prepareGrpcRequest,
} from './grpcClient';
import { grpcUnknownFieldsMode } from './unknownFields';

export type GrpcWebWireProtocol = Extract<GrpcWireProtocol, 'grpc-web' | 'grpc-web-text'>;

export function isGrpcWebWire(wire: GrpcWireProtocol | undefined): wire is GrpcWebWireProtocol {
  return wire === 'grpc-web' || wire === 'grpc-web-text';
}

/**
 * Whether the request carries a reflection-descriptor snapshot this platform
 * can load directly: Electron always; web only for gRPC-Web (which encodes
 * with the schema — the default Connect JSON path is schema-less).
 */
export function canUseDescriptorSnapshot(
  request: GrpcRequest
): request is GrpcRequest & { schema: Extract<GrpcSchemaSnapshot, { kind: 'descriptors' }> } {
  return (
    request.schema?.kind === 'descriptors' && (isElectron() || isGrpcWebWire(request.wireProtocol))
  );
}

/** Where the request schema can come from, most-lossless first. */
export interface GrpcSchemaSource {
  descriptors?: string[];
  protoContent?: string;
  /** Snapshot persisted on the request (collection runner / reopened tab). */
  snapshot?: GrpcSchemaSnapshot;
}

const NO_SCHEMA =
  'gRPC-Web needs the service schema — run server reflection or upload a .proto first.';

/** Build a registry that can resolve `service/method`, trying each source in turn. */
export function registryForGrpcWeb(
  src: GrpcSchemaSource,
  service: string,
  method: string
): { registry: Registry; method: DescMethod } {
  const candidates: Array<() => Registry> = [];
  if (src.descriptors?.length) candidates.push(() => registryFromDescriptors(src.descriptors!));
  if (src.snapshot?.kind === 'descriptors' && src.snapshot.descriptors.length) {
    const d = src.snapshot.descriptors;
    candidates.push(() => registryFromDescriptors(d));
  }
  if (src.protoContent) candidates.push(() => registryFromProtoText(src.protoContent!));
  if (src.snapshot?.kind === 'proto') {
    const text = src.snapshot.text;
    candidates.push(() => registryFromProtoText(text));
  }
  let lastError: unknown;
  for (const build of candidates) {
    try {
      const registry = build();
      return { registry, method: resolveMethod(registry, service, method).method };
    } catch (err) {
      lastError = err;
    }
  }
  throw new GrpcClientError(
    lastError instanceof Error ? lastError.message : NO_SCHEMA,
    GrpcStatusCode.FAILED_PRECONDITION,
    NO_SCHEMA
  );
}

/**
 * Encode editor JSON as base64 protobuf for the method's input type. Unknown
 * keys fail only in `block` mode (#944), matching the Connect stream path.
 */
export function encodeGrpcWebMessage(method: DescMethod, json: unknown): string {
  const message = inputFromJson(method, json, {
    ignoreUnknownFields: grpcUnknownFieldsMode() !== 'block',
  }) as Parameters<typeof toBinary>[1];
  return bytesToBase64(toBinary(method.input, message));
}

/** Decode one base64 protobuf response payload to JSON. */
export function decodeGrpcWebMessage(method: DescMethod, base64: string): unknown {
  return outputToJson(method, fromBinary(method.output, base64ToBytes(base64)));
}

/**
 * POST a spec to the Worker and yield its NDJSON events. A validation
 * rejection (HTTP 4xx JSON) or a broken stream becomes a synthetic `end`
 * event so callers have one code path.
 */
export async function* streamGrpcWebViaWorker(
  spec: GrpcWebSpec,
  signal?: AbortSignal
): AsyncGenerator<GrpcWebEvent, void, void> {
  const res = await fetch(`${workerBaseUrl()}/api/grpc-web`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
    body: JSON.stringify(spec),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    let message = `gRPC-Web proxy returned HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // non-JSON error body — keep the HTTP status message
    }
    yield syntheticEnd(
      res.status === 400 ? GrpcStatusCode.INVALID_ARGUMENT : GrpcStatusCode.UNAVAILABLE,
      message
    );
    return;
  }
  const parser = new NdjsonParser();
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      const values = done ? parser.flush() : parser.feed(value);
      for (const v of values) {
        if (v && typeof v === 'object' && 'type' in v) yield v as GrpcWebEvent;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function syntheticEnd(code: GrpcStatusCode, message: string): GrpcWebEndEvent {
  return {
    type: 'end',
    grpcStatus: code,
    grpcStatusText: GrpcStatusCodeName[code] ?? 'UNKNOWN',
    grpcMessage: message,
    trailers: {},
    size: 0,
  };
}

export interface PreparedGrpcWebCall {
  spec: GrpcWebSpec;
  method: DescMethod;
}

/** Resolve variables, auth metadata and schema into a Worker spec. */
export function prepareGrpcWebCall(
  request: GrpcRequest,
  resolveVariables: (text: string) => string,
  timeoutMs: number,
  src: GrpcSchemaSource
): PreparedGrpcWebCall {
  if (grpcAuthNeedsMainSideApply(request.auth)) {
    throw new GrpcClientError(
      'This credential uses a stored secret handle, which is only available in the Restura desktop app. ' +
        'Switch the credential to an inline value to use it on the web.',
      GrpcStatusCode.UNAUTHENTICATED
    );
  }
  assertProxyDeadline(timeoutMs);
  const prepared = prepareGrpcRequest(request, resolveVariables);
  const { method } = registryForGrpcWeb(
    { ...src, ...(request.schema ? { snapshot: request.schema } : {}) },
    request.service,
    request.method
  );
  const kind = callKindOf(method);
  if (kind === 'client-streaming' || kind === 'bidirectional-streaming') {
    throw new GrpcClientError(
      `${kind} is not supported over gRPC-Web (the protocol has no request streaming).`,
      GrpcStatusCode.UNIMPLEMENTED
    );
  }
  return {
    method,
    spec: {
      url: prepared.url,
      service: request.service,
      method: request.method,
      metadata: prepared.metadata,
      message: encodeGrpcWebMessage(method, prepared.message),
      timeout: timeoutMs,
      format: request.wireProtocol === 'grpc-web-text' ? 'text' : 'binary',
    },
  };
}

/**
 * Run a gRPC-Web call to completion through the Worker (unary, or a
 * server-stream buffered to the end) and shape it as a GrpcResponse.
 */
export async function makeGrpcWebRequest(
  request: GrpcRequest,
  resolveVariables: (text: string) => string,
  timeoutMs: number,
  src: GrpcSchemaSource
): Promise<GrpcResponse> {
  const startTime = Date.now();
  try {
    const { spec, method } = prepareGrpcWebCall(request, resolveVariables, timeoutMs, src);
    let headers: Record<string, string> = {};
    const messages: unknown[] = [];
    let end: GrpcWebEndEvent | undefined;
    for await (const ev of streamGrpcWebViaWorker(spec)) {
      if (ev.type === 'headers') headers = ev.headers;
      else if (ev.type === 'message') messages.push(decodeGrpcWebMessage(method, ev.data));
      else end = ev;
    }
    end ??= syntheticEnd(GrpcStatusCode.INTERNAL, 'gRPC-Web stream ended without a status');

    const ok = end.grpcStatus === GrpcStatusCode.OK;
    const streaming = callKindOf(method) === 'server-streaming';
    const payload = ok
      ? streaming
        ? messages
        : (messages[0] ?? {})
      : { error: end.grpcMessage ?? end.grpcStatusText };
    const body = JSON.stringify(payload, null, 2);
    const messageStrs = streaming ? messages.map((m) => JSON.stringify(m)) : undefined;
    return {
      id: uuidv4(),
      requestId: request.id,
      status: end.grpcStatus,
      statusText: end.grpcStatusText,
      headers,
      body,
      size: end.size || new Blob([body]).size,
      time: Date.now() - startTime,
      timestamp: Date.now(),
      grpcStatus: end.grpcStatus,
      grpcStatusText: end.grpcStatusText,
      trailers: end.trailers,
      ...(messageStrs ? { messages: messageStrs, isStreaming: true } : {}),
    };
  } catch (error: unknown) {
    return createErrorResponse(request.id, error, startTime);
  }
}
