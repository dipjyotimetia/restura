import type { EnumSchema, FieldSchema, MessageSchema } from '@/types';
import {
  type DescriptorProto,
  type EnumDescriptorProto,
  type EnumValueDescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
  type MethodDescriptorProto,
  type OneofDescriptorProto,
  type ServiceDescriptorProto,
  PROTO_FIELD_LABEL_MAP,
  PROTO_FIELD_TYPE_MAP,
} from './types';

const MAX_FILE_DESCRIPTOR_CACHE = 100;
const MAX_MESSAGE_SCHEMA_CACHE = 500;
const MAX_ENUM_SCHEMA_CACHE = 200;

export const fileDescriptorCache = new Map<string, FileDescriptorProto>();
export const messageSchemaCache = new Map<string, MessageSchema>();
export const enumSchemaCache = new Map<string, EnumSchema>();

export function addToCache<T>(cache: Map<string, T>, key: string, value: T, maxSize: number): void {
  if (cache.size >= maxSize) {
    const keysToDelete = Array.from(cache.keys()).slice(0, Math.ceil(maxSize * 0.1));
    keysToDelete.forEach((k) => cache.delete(k));
  }
  cache.set(key, value);
}

export function clearReflectionCache(): void {
  fileDescriptorCache.clear();
  messageSchemaCache.clear();
  enumSchemaCache.clear();
}

export function getCachedMessageSchema(typeName: string): MessageSchema | undefined {
  return messageSchemaCache.get(typeName);
}

export function getCachedEnumSchema(typeName: string): EnumSchema | undefined {
  return enumSchemaCache.get(typeName);
}

export function parseFileDescriptor(encodedProto: string): FileDescriptorProto {
  const binaryString = atob(encodedProto);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const descriptor = parseProtoWireFormat(bytes);
  if (descriptor.name) {
    addToCache(fileDescriptorCache, descriptor.name, descriptor, MAX_FILE_DESCRIPTOR_CACHE);
  }
  return descriptor;
}

export function cacheMessageTypes(fd: FileDescriptorProto): void {
  const packageName = fd.package || '';

  if (fd.messageType) {
    for (const msgType of fd.messageType) {
      cacheMessageType(msgType, packageName);
    }
  }

  if (fd.enumType) {
    for (const enumType of fd.enumType) {
      const fullName = packageName ? `${packageName}.${enumType.name}` : enumType.name || '';
      const enumSchema: EnumSchema = {
        name: enumType.name || '',
        fullName,
        values:
          enumType.value?.map((v) => ({
            name: v.name || '',
            number: v.number || 0,
          })) || [],
      };
      addToCache(enumSchemaCache, fullName, enumSchema, MAX_ENUM_SCHEMA_CACHE);
      addToCache(enumSchemaCache, `.${fullName}`, enumSchema, MAX_ENUM_SCHEMA_CACHE);
    }
  }
}

function cacheMessageType(msgType: DescriptorProto, parentName: string): void {
  const fullName = parentName ? `${parentName}.${msgType.name}` : msgType.name || '';

  const fields: FieldSchema[] =
    msgType.field?.map((f) => ({
      name: f.name || '',
      jsonName: f.jsonName || toJsonName(f.name || ''),
      number: f.number || 0,
      type: PROTO_FIELD_TYPE_MAP[f.type || 0] || 'TYPE_STRING',
      typeName: f.typeName,
      label: PROTO_FIELD_LABEL_MAP[f.label || 1] || 'LABEL_OPTIONAL',
      defaultValue: f.defaultValue,
      oneofIndex: f.oneofIndex,
    })) || [];

  const schema: MessageSchema = {
    name: msgType.name || '',
    fullName,
    fields,
  };

  addToCache(messageSchemaCache, fullName, schema, MAX_MESSAGE_SCHEMA_CACHE);
  addToCache(messageSchemaCache, `.${fullName}`, schema, MAX_MESSAGE_SCHEMA_CACHE);

  if (msgType.nestedType) {
    for (const nested of msgType.nestedType) {
      cacheMessageType(nested, fullName);
    }
  }

  if (msgType.enumType) {
    for (const enumType of msgType.enumType) {
      const enumFullName = `${fullName}.${enumType.name}`;
      const enumSchema: EnumSchema = {
        name: enumType.name || '',
        fullName: enumFullName,
        values:
          enumType.value?.map((v) => ({
            name: v.name || '',
            number: v.number || 0,
          })) || [],
      };
      addToCache(enumSchemaCache, enumFullName, enumSchema, MAX_ENUM_SCHEMA_CACHE);
      addToCache(enumSchemaCache, `.${enumFullName}`, enumSchema, MAX_ENUM_SCHEMA_CACHE);
    }
  }
}

function toJsonName(protoName: string): string {
  return protoName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseProtoWireFormat(bytes: Uint8Array): FileDescriptorProto {
  const result: FileDescriptorProto = {
    dependency: [],
    messageType: [],
    enumType: [],
    service: [],
  };

  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.newOffset;

    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    switch (fieldNumber) {
      case 1:
        if (wireType === 2) {
          const str = readString(bytes, offset);
          result.name = str.value;
          offset = str.newOffset;
        }
        break;

      case 2:
        if (wireType === 2) {
          const str = readString(bytes, offset);
          result.package = str.value;
          offset = str.newOffset;
        }
        break;

      case 3:
        if (wireType === 2) {
          const str = readString(bytes, offset);
          result.dependency!.push(str.value);
          offset = str.newOffset;
        }
        break;

      case 4:
        if (wireType === 2) {
          const msg = readLengthDelimited(bytes, offset);
          result.messageType!.push(parseDescriptorProto(msg.value));
          offset = msg.newOffset;
        }
        break;

      case 5:
        if (wireType === 2) {
          const msg = readLengthDelimited(bytes, offset);
          result.enumType!.push(parseEnumDescriptorProto(msg.value));
          offset = msg.newOffset;
        }
        break;

      case 6:
        if (wireType === 2) {
          const msg = readLengthDelimited(bytes, offset);
          result.service!.push(parseServiceDescriptorProto(msg.value));
          offset = msg.newOffset;
        }
        break;

      default:
        offset = skipField(bytes, offset, wireType);
        break;
    }
  }

  return result;
}

function parseDescriptorProto(bytes: Uint8Array): DescriptorProto {
  const result: DescriptorProto = { field: [], nestedType: [], enumType: [], oneofDecl: [] };
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.newOffset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    switch (fieldNumber) {
      case 1:
        if (wireType === 2) {
          const str = readString(bytes, offset);
          result.name = str.value;
          offset = str.newOffset;
        }
        break;
      case 2:
        if (wireType === 2) {
          const msg = readLengthDelimited(bytes, offset);
          result.field!.push(parseFieldDescriptorProto(msg.value));
          offset = msg.newOffset;
        }
        break;
      case 3:
        if (wireType === 2) {
          const msg = readLengthDelimited(bytes, offset);
          result.nestedType!.push(parseDescriptorProto(msg.value));
          offset = msg.newOffset;
        }
        break;
      case 4:
        if (wireType === 2) {
          const msg = readLengthDelimited(bytes, offset);
          result.enumType!.push(parseEnumDescriptorProto(msg.value));
          offset = msg.newOffset;
        }
        break;
      case 8:
        if (wireType === 2) {
          const msg = readLengthDelimited(bytes, offset);
          result.oneofDecl!.push(parseOneofDescriptorProto(msg.value));
          offset = msg.newOffset;
        }
        break;
      default:
        offset = skipField(bytes, offset, wireType);
        break;
    }
  }

  return result;
}

function parseFieldDescriptorProto(bytes: Uint8Array): FieldDescriptorProto {
  const result: FieldDescriptorProto = {};
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.newOffset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    switch (fieldNumber) {
      case 1:
        if (wireType === 2) { const str = readString(bytes, offset); result.name = str.value; offset = str.newOffset; }
        break;
      case 3:
        if (wireType === 0) { const num = readVarint(bytes, offset); result.number = num.value; offset = num.newOffset; }
        break;
      case 4:
        if (wireType === 0) { const lbl = readVarint(bytes, offset); result.label = lbl.value; offset = lbl.newOffset; }
        break;
      case 5:
        if (wireType === 0) { const typ = readVarint(bytes, offset); result.type = typ.value; offset = typ.newOffset; }
        break;
      case 6:
        if (wireType === 2) { const str = readString(bytes, offset); result.typeName = str.value; offset = str.newOffset; }
        break;
      case 7:
        if (wireType === 2) { const str = readString(bytes, offset); result.defaultValue = str.value; offset = str.newOffset; }
        break;
      case 9:
        if (wireType === 0) { const idx = readVarint(bytes, offset); result.oneofIndex = idx.value; offset = idx.newOffset; }
        break;
      case 10:
        if (wireType === 2) { const str = readString(bytes, offset); result.jsonName = str.value; offset = str.newOffset; }
        break;
      default:
        offset = skipField(bytes, offset, wireType);
        break;
    }
  }

  return result;
}

function parseEnumDescriptorProto(bytes: Uint8Array): EnumDescriptorProto {
  const result: EnumDescriptorProto = { value: [] };
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.newOffset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    switch (fieldNumber) {
      case 1:
        if (wireType === 2) { const str = readString(bytes, offset); result.name = str.value; offset = str.newOffset; }
        break;
      case 2:
        if (wireType === 2) {
          const msg = readLengthDelimited(bytes, offset);
          result.value!.push(parseEnumValueDescriptorProto(msg.value));
          offset = msg.newOffset;
        }
        break;
      default:
        offset = skipField(bytes, offset, wireType);
        break;
    }
  }

  return result;
}

function parseEnumValueDescriptorProto(bytes: Uint8Array): EnumValueDescriptorProto {
  const result: EnumValueDescriptorProto = {};
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.newOffset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    switch (fieldNumber) {
      case 1:
        if (wireType === 2) { const str = readString(bytes, offset); result.name = str.value; offset = str.newOffset; }
        break;
      case 2:
        if (wireType === 0) { const num = readVarint(bytes, offset); result.number = num.value; offset = num.newOffset; }
        break;
      default:
        offset = skipField(bytes, offset, wireType);
        break;
    }
  }

  return result;
}

function parseServiceDescriptorProto(bytes: Uint8Array): ServiceDescriptorProto {
  const result: ServiceDescriptorProto = { method: [] };
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.newOffset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    switch (fieldNumber) {
      case 1:
        if (wireType === 2) { const str = readString(bytes, offset); result.name = str.value; offset = str.newOffset; }
        break;
      case 2:
        if (wireType === 2) {
          const msg = readLengthDelimited(bytes, offset);
          result.method!.push(parseMethodDescriptorProto(msg.value));
          offset = msg.newOffset;
        }
        break;
      default:
        offset = skipField(bytes, offset, wireType);
        break;
    }
  }

  return result;
}

function parseMethodDescriptorProto(bytes: Uint8Array): MethodDescriptorProto {
  const result: MethodDescriptorProto = { clientStreaming: false, serverStreaming: false };
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.newOffset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    switch (fieldNumber) {
      case 1:
        if (wireType === 2) { const str = readString(bytes, offset); result.name = str.value; offset = str.newOffset; }
        break;
      case 2:
        if (wireType === 2) { const str = readString(bytes, offset); result.inputType = str.value; offset = str.newOffset; }
        break;
      case 3:
        if (wireType === 2) { const str = readString(bytes, offset); result.outputType = str.value; offset = str.newOffset; }
        break;
      case 5:
        if (wireType === 0) { const val = readVarint(bytes, offset); result.clientStreaming = val.value !== 0; offset = val.newOffset; }
        break;
      case 6:
        if (wireType === 0) { const val = readVarint(bytes, offset); result.serverStreaming = val.value !== 0; offset = val.newOffset; }
        break;
      default:
        offset = skipField(bytes, offset, wireType);
        break;
    }
  }

  return result;
}

function parseOneofDescriptorProto(bytes: Uint8Array): OneofDescriptorProto {
  const result: OneofDescriptorProto = {};
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.newOffset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;

    if (fieldNumber === 1 && wireType === 2) {
      const str = readString(bytes, offset);
      result.name = str.value;
      offset = str.newOffset;
    } else {
      offset = skipField(bytes, offset, wireType);
    }
  }

  return result;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; newOffset: number } {
  let value = 0;
  let shift = 0;
  let currentOffset = offset;

  while (currentOffset < bytes.length) {
    const byte = bytes[currentOffset]!;
    value |= (byte & 0x7f) << shift;
    currentOffset++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  return { value, newOffset: currentOffset };
}

function readString(bytes: Uint8Array, offset: number): { value: string; newOffset: number } {
  const length = readVarint(bytes, offset);
  const stringBytes = bytes.slice(length.newOffset, length.newOffset + length.value);
  const value = new TextDecoder().decode(stringBytes);
  return { value, newOffset: length.newOffset + length.value };
}

function readLengthDelimited(bytes: Uint8Array, offset: number): { value: Uint8Array; newOffset: number } {
  const length = readVarint(bytes, offset);
  const value = bytes.slice(length.newOffset, length.newOffset + length.value);
  return { value, newOffset: length.newOffset + length.value };
}

function skipField(bytes: Uint8Array, offset: number, wireType: number): number {
  switch (wireType) {
    case 0:
      return readVarint(bytes, offset).newOffset;
    case 1:
      return offset + 8;
    case 2: {
      const length = readVarint(bytes, offset);
      return length.newOffset + length.value;
    }
    case 5:
      return offset + 4;
    default:
      return offset;
  }
}
