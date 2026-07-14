import type {
  FieldSchema,
  FieldType,
  MessageSchema,
  ReflectionMethodInfo,
  ReflectionServiceInfo,
} from '@/types';
import { enumSchemaCache, messageSchemaCache } from './protoParser';
import type { ServiceDescriptorProto } from './types';

export function buildServiceInfo(
  svc: ServiceDescriptorProto,
  packageName: string
): ReflectionServiceInfo {
  const fullName = packageName ? `${packageName}.${svc.name}` : svc.name || '';

  const methods: ReflectionMethodInfo[] =
    svc.method?.map((method) => ({
      name: method.name || '',
      fullName: `${fullName}/${method.name}`,
      inputType: method.inputType || '',
      outputType: method.outputType || '',
      clientStreaming: method.clientStreaming || false,
      serverStreaming: method.serverStreaming || false,
      inputMessageSchema: getMessageSchema(method.inputType || ''),
      outputMessageSchema: getMessageSchema(method.outputType || ''),
    })) || [];

  return { name: svc.name || '', fullName, methods };
}

export function getMessageSchema(typeName: string): MessageSchema {
  return (
    messageSchemaCache.get(typeName) ?? {
      name: typeName.split('.').pop() || typeName,
      fullName: typeName,
      fields: [],
    }
  );
}

export function generateRequestTemplate(schema: MessageSchema, maxDepth = 5): string {
  return JSON.stringify(generateTemplateObject(schema, maxDepth, 0, new Set()), null, 2);
}

function generateTemplateObject(
  schema: MessageSchema,
  maxDepth: number,
  currentDepth: number,
  visited: Set<string>
): Record<string, unknown> {
  if (currentDepth >= maxDepth || visited.has(schema.fullName)) return {};

  visited.add(schema.fullName);
  const result: Record<string, unknown> = {};

  for (const field of schema.fields) {
    const fieldValue = generateFieldValue(field, maxDepth, currentDepth + 1, new Set(visited));
    result[field.jsonName] = field.label === 'LABEL_REPEATED' ? [fieldValue] : fieldValue;
  }

  return result;
}

function generateFieldValue(
  field: FieldSchema,
  maxDepth: number,
  currentDepth: number,
  visited: Set<string>
): unknown {
  if (field.mapKey && field.mapValue) {
    const keyValue = generateFieldValue(field.mapKey, maxDepth, currentDepth, visited);
    const valueValue = generateFieldValue(field.mapValue, maxDepth, currentDepth, visited);
    return { [String(keyValue)]: valueValue };
  }

  switch (field.type) {
    case 'TYPE_DOUBLE':
    case 'TYPE_FLOAT':
      return 0.0;

    case 'TYPE_INT64':
    case 'TYPE_UINT64':
    case 'TYPE_INT32':
    case 'TYPE_FIXED64':
    case 'TYPE_FIXED32':
    case 'TYPE_UINT32':
    case 'TYPE_SFIXED32':
    case 'TYPE_SFIXED64':
    case 'TYPE_SINT32':
    case 'TYPE_SINT64':
      return 0;

    case 'TYPE_BOOL':
      return false;

    case 'TYPE_STRING':
      return `<${field.name}>`;

    case 'TYPE_BYTES':
      return '';

    case 'TYPE_ENUM': {
      const enumSchema = enumSchemaCache.get(field.typeName || '');
      return enumSchema?.values.length ? enumSchema.values[0]!.name : 0;
    }

    case 'TYPE_MESSAGE': {
      if (field.typeName) {
        const shortName = field.typeName.split('.').pop();
        switch (shortName) {
          case 'Timestamp':
            return new Date().toISOString();
          case 'Duration':
            return '0s';
          case 'Any':
            return { '@type': '', value: {} };
          case 'Value':
            return null;
          case 'Struct':
            return {};
          case 'ListValue':
            return [];
          case 'Empty':
            return {};
        }
        const nestedSchema = messageSchemaCache.get(field.typeName);
        if (nestedSchema)
          return generateTemplateObject(nestedSchema, maxDepth, currentDepth, visited);
      }
      return {};
    }

    case 'TYPE_GROUP':
      return {};

    default:
      return null;
  }
}

export function getFieldTypeDescription(type: FieldType): string {
  switch (type) {
    case 'TYPE_DOUBLE':
      return 'double-precision floating point';
    case 'TYPE_FLOAT':
      return 'single-precision floating point';
    case 'TYPE_INT64':
      return '64-bit signed integer';
    case 'TYPE_UINT64':
      return '64-bit unsigned integer';
    case 'TYPE_INT32':
      return '32-bit signed integer';
    case 'TYPE_FIXED64':
      return '64-bit unsigned integer (fixed encoding)';
    case 'TYPE_FIXED32':
      return '32-bit unsigned integer (fixed encoding)';
    case 'TYPE_BOOL':
      return 'boolean';
    case 'TYPE_STRING':
      return 'UTF-8 string';
    case 'TYPE_GROUP':
      return 'group (deprecated)';
    case 'TYPE_MESSAGE':
      return 'embedded message';
    case 'TYPE_BYTES':
      return 'byte array';
    case 'TYPE_UINT32':
      return '32-bit unsigned integer';
    case 'TYPE_ENUM':
      return 'enumeration';
    case 'TYPE_SFIXED32':
      return '32-bit signed integer (fixed encoding)';
    case 'TYPE_SFIXED64':
      return '64-bit signed integer (fixed encoding)';
    case 'TYPE_SINT32':
      return '32-bit signed integer (ZigZag encoding)';
    case 'TYPE_SINT64':
      return '64-bit signed integer (ZigZag encoding)';
    default:
      return 'unknown type';
  }
}

export function validateRequestAgainstSchema(
  message: unknown,
  schema: MessageSchema
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof message !== 'object' || message === null) {
    return { valid: false, errors: ['Message must be an object'] };
  }

  const messageObj = message as Record<string, unknown>;
  const knownFields = new Set(schema.fields.map((f) => f.jsonName));

  for (const key of Object.keys(messageObj)) {
    if (!knownFields.has(key)) errors.push(`Unknown field: ${key}`);
  }

  for (const field of schema.fields) {
    const value = messageObj[field.jsonName];
    if (field.label === 'LABEL_REQUIRED' && value === undefined) {
      errors.push(`Missing required field: ${field.jsonName}`);
      continue;
    }
    if (value === undefined) continue;
    const typeError = validateFieldType(value, field);
    if (typeError) errors.push(`Field ${field.jsonName}: ${typeError}`);
  }

  return { valid: errors.length === 0, errors };
}

function validateFieldType(value: unknown, field: FieldSchema): string | null {
  if (field.label === 'LABEL_REPEATED') {
    if (!Array.isArray(value)) return 'expected array';
    for (let i = 0; i < value.length; i++) {
      const itemError = validateSingleFieldType(value[i], field);
      if (itemError) return `item ${i}: ${itemError}`;
    }
    return null;
  }
  return validateSingleFieldType(value, field);
}

function validateSingleFieldType(value: unknown, field: FieldSchema): string | null {
  switch (field.type) {
    case 'TYPE_DOUBLE':
    case 'TYPE_FLOAT':
    case 'TYPE_INT64':
    case 'TYPE_UINT64':
    case 'TYPE_INT32':
    case 'TYPE_FIXED64':
    case 'TYPE_FIXED32':
    case 'TYPE_UINT32':
    case 'TYPE_SFIXED32':
    case 'TYPE_SFIXED64':
    case 'TYPE_SINT32':
    case 'TYPE_SINT64':
      if (typeof value !== 'number' && typeof value !== 'string') return 'expected number';
      break;
    case 'TYPE_BOOL':
      if (typeof value !== 'boolean') return 'expected boolean';
      break;
    case 'TYPE_STRING':
    case 'TYPE_BYTES':
      if (typeof value !== 'string') return 'expected string';
      break;
    case 'TYPE_ENUM':
      if (typeof value !== 'string' && typeof value !== 'number')
        return 'expected string or number';
      break;
    case 'TYPE_MESSAGE':
      if (typeof value !== 'object' || value === null) return 'expected object';
      break;
  }
  return null;
}

export function formatMessageSchemaForDisplay(schema: MessageSchema): string {
  const lines: string[] = [`message ${schema.name} {`];

  for (const field of schema.fields) {
    const label =
      field.label === 'LABEL_REPEATED'
        ? 'repeated '
        : field.label === 'LABEL_REQUIRED'
          ? 'required '
          : '';
    const type =
      field.type === 'TYPE_MESSAGE' || field.type === 'TYPE_ENUM'
        ? field.typeName?.split('.').pop() || field.type
        : getProtoTypeName(field.type);
    lines.push(`  ${label}${type} ${field.name} = ${field.number};`);
  }

  lines.push('}');
  return lines.join('\n');
}

function getProtoTypeName(type: FieldType): string {
  switch (type) {
    case 'TYPE_DOUBLE':
      return 'double';
    case 'TYPE_FLOAT':
      return 'float';
    case 'TYPE_INT64':
      return 'int64';
    case 'TYPE_UINT64':
      return 'uint64';
    case 'TYPE_INT32':
      return 'int32';
    case 'TYPE_FIXED64':
      return 'fixed64';
    case 'TYPE_FIXED32':
      return 'fixed32';
    case 'TYPE_BOOL':
      return 'bool';
    case 'TYPE_STRING':
      return 'string';
    case 'TYPE_BYTES':
      return 'bytes';
    case 'TYPE_UINT32':
      return 'uint32';
    case 'TYPE_SFIXED32':
      return 'sfixed32';
    case 'TYPE_SFIXED64':
      return 'sfixed64';
    case 'TYPE_SINT32':
      return 'sint32';
    case 'TYPE_SINT64':
      return 'sint64';
    default:
      return 'unknown';
  }
}

export function generateProtoFromReflection(
  serviceName: string,
  serviceInfo: ReflectionServiceInfo
): string {
  const lines: string[] = ['syntax = "proto3";', ''];

  const packageParts = serviceName.split('.');
  const serviceShortName = packageParts.pop() || serviceName;
  const packageName = packageParts.join('.');

  if (packageName) {
    lines.push(`package ${packageName};`, '');
  }

  const messageTypes = new Set<string>();
  for (const method of serviceInfo.methods) {
    if (method.inputMessageSchema) collectMessageTypes(method.inputMessageSchema, messageTypes);
    if (method.outputMessageSchema) collectMessageTypes(method.outputMessageSchema, messageTypes);
  }

  for (const typeName of messageTypes) {
    const schema = messageSchemaCache.get(typeName);
    if (schema) {
      lines.push(generateMessageDefinition(schema), '');
    }
  }

  lines.push(`service ${serviceShortName} {`);
  for (const method of serviceInfo.methods) {
    const inputType = method.inputType.split('.').pop() || method.inputType;
    const outputType = method.outputType.split('.').pop() || method.outputType;
    const clientStream = method.clientStreaming ? 'stream ' : '';
    const serverStream = method.serverStreaming ? 'stream ' : '';
    lines.push(
      `  rpc ${method.name} (${clientStream}${inputType}) returns (${serverStream}${outputType});`
    );
  }
  lines.push('}');

  return lines.join('\n');
}

function collectMessageTypes(schema: MessageSchema, types: Set<string>): void {
  if (types.has(schema.fullName)) return;
  types.add(schema.fullName);

  for (const field of schema.fields) {
    if (field.type === 'TYPE_MESSAGE' && field.typeName) {
      const nestedSchema = messageSchemaCache.get(field.typeName);
      if (nestedSchema) collectMessageTypes(nestedSchema, types);
    }
  }
}

function generateMessageDefinition(schema: MessageSchema): string {
  const lines: string[] = [`message ${schema.name} {`];

  for (const field of schema.fields) {
    const label = field.label === 'LABEL_REPEATED' ? 'repeated ' : '';
    const type =
      field.type === 'TYPE_MESSAGE' || field.type === 'TYPE_ENUM'
        ? field.typeName?.split('.').pop() || 'string'
        : getProtoTypeName(field.type);
    lines.push(`  ${label}${type} ${field.name} = ${field.number};`);
  }

  lines.push('}');
  return lines.join('\n');
}
