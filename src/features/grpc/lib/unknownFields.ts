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
  removeUnknownJsonFields,
  type UnknownJsonField,
} from '@shared/protocol/grpc-unknown-fields';
import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { GrpcRequest, GrpcResponse, GrpcSchemaSnapshot, GrpcUnknownFieldsMode } from '@/types';
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

/** The configured unknown-field policy (#944). Absent setting = `warn`. */
export function grpcUnknownFieldsMode(): GrpcUnknownFieldsMode {
  return useSettingsStore.getState().settings.grpcUnknownFields ?? 'warn';
}

/** Locate a key's token in the (variable-masked) JSON text. */
function keyRange(
  text: string,
  field: UnknownJsonField
): { offset: number; length: number } | null {
  const root = parseTree(maskTemplateVariables(text));
  const value = root ? findNodeAtLocation(root, [...field.parentPath, field.key]) : undefined;
  const key = value?.parent?.type === 'property' ? value.parent.children?.[0] : undefined;
  return key ? { offset: key.offset, length: key.length } : null;
}

/**
 * Quick fix: rename one unknown key in the editor text, preserving formatting
 * and `{{variables}}`. Returns the text unchanged when the key isn't found.
 */
export function renameJsonKey(text: string, field: UnknownJsonField, newKey: string): string {
  const range = keyRange(text, field);
  if (!range) return text;
  return (
    text.slice(0, range.offset) + JSON.stringify(newKey) + text.slice(range.offset + range.length)
  );
}

/** Remove the given keys (and their values) from the editor text. */
export function removeJsonKeys(text: string, fields: readonly UnknownJsonField[]): string {
  let out = text;
  // Last first, re-parsing between edits so every edit sees current offsets.
  for (const field of [...fields].reverse()) {
    const edits = modify(
      maskTemplateVariables(out),
      [...field.parentPath, field.key],
      undefined,
      {}
    );
    out = applyEdits(out, edits);
  }
  return out;
}

/**
 * Apply the unknown-field policy to a unary request before it is sent:
 *  - `block`: unknown keys (checked on the variable-resolved message) refuse
 *    the send with an INVALID_ARGUMENT response listing them;
 *  - `warn` / `off`: the keys are removed from the message text, so the
 *    strict encoder downstream never sees them (the editor lint is the
 *    warning — the runner also serves headless collection runs).
 */
export function applyUnknownFieldPolicy(
  request: GrpcRequest,
  source: GrpcSchemaSource,
  resolve: (text: string) => string,
  mode: GrpcUnknownFieldsMode = grpcUnknownFieldsMode()
): { request: GrpcRequest; refused?: GrpcResponse } {
  if (mode === 'block') {
    const unknown = unknownRequestFields(request, source, resolve(request.message));
    return unknown.length > 0
      ? { request, refused: unknownFieldsResponse(request.id, unknown, request.method) }
      : { request };
  }
  const drop = unknownRequestFields(request, source);
  return drop.length > 0
    ? { request: { ...request, message: removeJsonKeys(request.message, drop) } }
    : { request };
}

/** Strip unknown keys from an already-parsed message (streaming sends). */
export function withoutUnknownFields<T>(input: DescMessage | null, message: T): T {
  return input ? removeUnknownJsonFields(input, message) : message;
}
