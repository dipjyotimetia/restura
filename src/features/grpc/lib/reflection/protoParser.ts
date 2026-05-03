import type { EnumSchema, FieldSchema, MessageSchema } from '@/types';
import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import {
  type DescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
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
  const binaryStr = atob(encodedProto);
  const bytes = Uint8Array.from({ length: binaryStr.length }, (_, i) => binaryStr.charCodeAt(i));
  const descriptor = fromBinary(FileDescriptorProtoSchema, bytes) as unknown as FileDescriptorProto;
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

function buildFieldSchema(f: FieldDescriptorProto): FieldSchema {
  return {
    name: f.name || '',
    jsonName: f.jsonName || toJsonName(f.name || ''),
    number: f.number || 0,
    type: PROTO_FIELD_TYPE_MAP[f.type || 0] || 'TYPE_STRING',
    typeName: f.typeName,
    label: PROTO_FIELD_LABEL_MAP[f.label || 1] || 'LABEL_OPTIONAL',
    defaultValue: f.defaultValue,
    oneofIndex: f.oneofIndex,
  };
}

function cacheMessageType(msgType: DescriptorProto, parentName: string): void {
  const fullName = parentName ? `${parentName}.${msgType.name}` : msgType.name || '';

  // Build map of nested map-entry types keyed by their short name (e.g. "LabelsEntry")
  const mapEntries = new Map<string, DescriptorProto>();
  if (msgType.nestedType) {
    for (const nested of msgType.nestedType) {
      if (nested.options?.mapEntry && nested.name) {
        mapEntries.set(nested.name, nested);
      }
    }
  }

  const fields: FieldSchema[] =
    msgType.field?.map((f) => {
      const schema = buildFieldSchema(f);

      // Detect map fields: LABEL_REPEATED + TYPE_MESSAGE pointing to a map-entry nested type
      if (f.label === 3 && f.type === 11 && f.typeName && mapEntries.size > 0) {
        const shortName = f.typeName.split('.').at(-1) ?? '';
        const entryType = mapEntries.get(shortName);
        if (entryType?.field) {
          const keyField = entryType.field.find((ef) => ef.number === 1);
          const valueField = entryType.field.find((ef) => ef.number === 2);
          if (keyField) schema.mapKey = buildFieldSchema(keyField);
          if (valueField) schema.mapValue = buildFieldSchema(valueField);
        }
      }

      return schema;
    }) || [];

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
