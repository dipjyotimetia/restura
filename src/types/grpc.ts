import type { KeyValue } from './common';
import type { AuthConfig } from './auth';
import type { Response } from './http';
// gRPC status codes — single source of truth in the shared protocol core.
import { GrpcStatusCode, GrpcStatusCodeName } from '@shared/protocol/grpc-status';

// gRPC Methods
export type GrpcMethodType =
  | 'unary'
  | 'server-streaming'
  | 'client-streaming'
  | 'bidirectional-streaming';

// gRPC Status Codes — re-exported from @shared/protocol/grpc-status (the single
// source of truth shared with the Worker/Electron gRPC proxy). Two separate enum
// declarations would be nominally distinct types, so this must not be redefined.
export { GrpcStatusCode, GrpcStatusCodeName };

// gRPC Request
//
// NOTE: structurally mirrors `GrpcSpec` in `shared/protocol/grpc-proxy.ts`.
// The parity test `tests/grpc-spec-parity.test.ts` guards against drift.
export interface GrpcRequest {
  id: string;
  name: string;
  type: 'grpc';
  methodType: GrpcMethodType;
  url: string;
  service: string;
  method: string;
  metadata: KeyValue[];
  message: string;
  auth: AuthConfig;
  preRequestScript?: string;
  testScript?: string;
}

// gRPC Response (specialized for gRPC)
export interface GrpcResponse extends Response {
  grpcStatus?: GrpcStatusCode;
  grpcStatusText?: string;
  trailers?: Record<string, string>;
  messages?: string[]; // For streaming responses, each message as JSON string
  isStreaming?: boolean;
}

// Proto File Definition (parsed)
export interface ProtoServiceDefinition {
  name: string;
  fullName: string; // e.g., "greet.v1.GreetService"
  methods: ProtoMethodDefinition[];
}

export interface ProtoMethodDefinition {
  name: string;
  inputType: string;
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

export interface ProtoFileInfo {
  fileName: string;
  package: string;
  services: ProtoServiceDefinition[];
  messages: Record<string, ProtoMessageDefinition>;
}

export interface ProtoMessageDefinition {
  name: string;
  fields: ProtoFieldDefinition[];
}

export interface ProtoFieldDefinition {
  name: string;
  type: string;
  number: number;
  repeated: boolean;
  optional: boolean;
}

// gRPC Reflection Types
export interface ReflectionServiceInfo {
  name: string;
  fullName: string;
  methods: ReflectionMethodInfo[];
  /**
   * Base64 binary FileDescriptorProtos (the file containing this service plus
   * its transitive imports) as returned by reflection. Threaded to the Electron
   * gRPC call so it loads the complete descriptor set via proto-loader instead
   * of lossy reconstructed `.proto` text. Electron-only — undefined on web.
   */
  descriptors?: string[];
}

export interface ReflectionMethodInfo {
  name: string;
  fullName: string;
  inputType: string;
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  inputMessageSchema: MessageSchema;
  outputMessageSchema: MessageSchema;
}

export interface MessageSchema {
  name: string;
  fullName: string;
  fields: FieldSchema[];
}

export interface FieldSchema {
  name: string;
  jsonName: string;
  number: number;
  type: FieldType;
  typeName?: string; // For message/enum types
  label: FieldLabel;
  defaultValue?: unknown;
  oneofIndex?: number;
  mapKey?: FieldSchema;
  mapValue?: FieldSchema;
}

export type FieldType =
  | 'TYPE_DOUBLE'
  | 'TYPE_FLOAT'
  | 'TYPE_INT64'
  | 'TYPE_UINT64'
  | 'TYPE_INT32'
  | 'TYPE_FIXED64'
  | 'TYPE_FIXED32'
  | 'TYPE_BOOL'
  | 'TYPE_STRING'
  | 'TYPE_GROUP'
  | 'TYPE_MESSAGE'
  | 'TYPE_BYTES'
  | 'TYPE_UINT32'
  | 'TYPE_ENUM'
  | 'TYPE_SFIXED32'
  | 'TYPE_SFIXED64'
  | 'TYPE_SINT32'
  | 'TYPE_SINT64';

export type FieldLabel = 'LABEL_OPTIONAL' | 'LABEL_REQUIRED' | 'LABEL_REPEATED';

export interface ReflectionResult {
  success: boolean;
  services: ReflectionServiceInfo[];
  error?: string;
  serverUrl: string;
  timestamp: number;
}

export interface EnumSchema {
  name: string;
  fullName: string;
  values: EnumValue[];
}

export interface EnumValue {
  name: string;
  number: number;
}
