/**
 * Renderer-side unknown-field checks for gRPC request JSON (#925).
 *
 * The web unary path never encodes the message client-side (the Worker relays
 * JSON over the Connect protocol), so the strict `inputFromJson` in the shared
 * registry can't catch a typo there. These helpers resolve the method's input
 * descriptor from whatever schema the request carries and diff the editor JSON
 * against it, so every harness rejects (or, per setting, warns about) unknown
 * keys BEFORE anything is sent.
 */
import type { DescMessage } from '@bufbuild/protobuf';
import {
  registryFromDescriptors,
  registryFromProtoText,
  resolveMethod,
} from '@shared/protocol/grpc-registry';
import {
  describeUnknownFields,
  findUnknownJsonFields,
  GrpcUnknownFieldsError,
  type UnknownJsonField,
} from '@shared/protocol/grpc-unknown-fields';
import type { GrpcRequest, GrpcResponse, GrpcSchemaSnapshot } from '@/types';
import { GrpcStatusCode } from '@/types';
import { createErrorResponse, GrpcClientError } from './grpcClient';

/** Any schema the builder / runner may hold for a request. */
export interface GrpcSchemaSource {
  descriptors?: string[] | undefined;
  protoContent?: string | undefined;
  protoFileName?: string | undefined;
}

/** Map a persisted snapshot onto a schema source. */
export function schemaSourceFromSnapshot(schema: GrpcSchemaSnapshot | undefined): GrpcSchemaSource {
  if (schema?.kind === 'descriptors') return { descriptors: schema.descriptors };
  if (schema?.kind === 'proto')
    return { protoContent: schema.text, protoFileName: schema.fileName };
  return {};
}

/**
 * The method's input message descriptor, or null when there's no usable
 * schema or the service/method isn't in it (the lint then simply stays quiet).
 */
export function resolveInputMessage(
  request: Pick<GrpcRequest, 'service' | 'method'>,
  source: GrpcSchemaSource
): DescMessage | null {
  if (!request.service || !request.method) return null;
  try {
    const registry = source.descriptors?.length
      ? registryFromDescriptors(source.descriptors)
      : source.protoContent
        ? registryFromProtoText(source.protoContent, source.protoFileName)
        : null;
    if (!registry) return null;
    return resolveMethod(registry, request.service, request.method).method.input;
  } catch {
    return null;
  }
}

/**
 * Parse editor JSON for linting. `{{variables}}` are replaced by a same-length
 * placeholder first, so an unquoted `{{count}}` still parses and byte offsets
 * stay aligned with the original text. Returns undefined when not valid JSON.
 */
export function parseMessageForLint(message: string): unknown {
  const text = maskTemplateVariables(message).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `{{name}}` → `0` padded with spaces to the same length (offset-preserving). */
export function maskTemplateVariables(text: string): string {
  return text.replace(/\{\{[^{}]*\}\}/g, (m) => `0${' '.repeat(m.length - 1)}`);
}

/** Unknown keys in a request's message against the given schema ([] when unknowable). */
export function unknownRequestFields(
  request: Pick<GrpcRequest, 'service' | 'method' | 'message'>,
  source: GrpcSchemaSource,
  message: string = request.message
): UnknownJsonField[] {
  const input = resolveInputMessage(request, source);
  if (!input) return [];
  const json = parseMessageForLint(message);
  return json === undefined ? [] : findUnknownJsonFields(input, json);
}

/**
 * The response for a send refused because of unknown keys: INVALID_ARGUMENT
 * with the same message the strict encoder produces on the wire paths.
 */
export function unknownFieldsResponse(
  requestId: string,
  fields: UnknownJsonField[],
  method: string
): GrpcResponse {
  const err = new GrpcUnknownFieldsError(fields, method || 'the');
  return createErrorResponse(
    requestId,
    new GrpcClientError(
      err.rawMessage,
      GrpcStatusCode.INVALID_ARGUMENT,
      describeUnknownFields(fields)
    ),
    Date.now()
  );
}
