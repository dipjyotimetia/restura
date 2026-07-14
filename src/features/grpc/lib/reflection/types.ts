import type { FieldLabel, FieldType } from '@/types';

export const REFLECTION_SERVICE_V1 = 'grpc.reflection.v1.ServerReflection';
export const REFLECTION_SERVICE_V1_ALPHA = 'grpc.reflection.v1alpha.ServerReflection';

export const PROTO_FIELD_TYPE_MAP: Record<number, FieldType> = {
  1: 'TYPE_DOUBLE',
  2: 'TYPE_FLOAT',
  3: 'TYPE_INT64',
  4: 'TYPE_UINT64',
  5: 'TYPE_INT32',
  6: 'TYPE_FIXED64',
  7: 'TYPE_FIXED32',
  8: 'TYPE_BOOL',
  9: 'TYPE_STRING',
  10: 'TYPE_GROUP',
  11: 'TYPE_MESSAGE',
  12: 'TYPE_BYTES',
  13: 'TYPE_UINT32',
  14: 'TYPE_ENUM',
  15: 'TYPE_SFIXED32',
  16: 'TYPE_SFIXED64',
  17: 'TYPE_SINT32',
  18: 'TYPE_SINT64',
};

export const PROTO_FIELD_LABEL_MAP: Record<number, FieldLabel> = {
  1: 'LABEL_OPTIONAL',
  2: 'LABEL_REQUIRED',
  3: 'LABEL_REPEATED',
};

export interface RawReflectionResponse {
  listServicesResponse?: {
    service: Array<{ name: string }>;
  };
  fileDescriptorResponse?: {
    fileDescriptorProto: string[];
  };
  errorResponse?: {
    errorCode: number;
    errorMessage: string;
  };
}

export interface FileDescriptorProto {
  name?: string;
  package?: string;
  dependency?: string[];
  messageType?: DescriptorProto[];
  enumType?: EnumDescriptorProto[];
  service?: ServiceDescriptorProto[];
}

export interface MessageOptions {
  mapEntry?: boolean;
}

export interface DescriptorProto {
  name?: string;
  field?: FieldDescriptorProto[];
  nestedType?: DescriptorProto[];
  enumType?: EnumDescriptorProto[];
  oneofDecl?: OneofDescriptorProto[];
  options?: MessageOptions;
}

export interface FieldDescriptorProto {
  name?: string;
  number?: number;
  label?: number;
  type?: number;
  typeName?: string;
  defaultValue?: string;
  oneofIndex?: number;
  jsonName?: string;
}

export interface EnumDescriptorProto {
  name?: string;
  value?: EnumValueDescriptorProto[];
}

export interface EnumValueDescriptorProto {
  name?: string;
  number?: number;
}

export interface ServiceDescriptorProto {
  name?: string;
  method?: MethodDescriptorProto[];
}

export interface MethodDescriptorProto {
  name?: string;
  inputType?: string;
  outputType?: string;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
}

export interface OneofDescriptorProto {
  name?: string;
}
