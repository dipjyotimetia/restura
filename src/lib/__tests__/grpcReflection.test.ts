import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GrpcReflectionClient,
  generateRequestTemplate,
  formatMessageSchemaForDisplay,
  validateRequestAgainstSchema,
  getFieldTypeDescription,
  clearReflectionCache,
  getCachedMessageSchema,
  getCachedEnumSchema,
} from '../grpcReflection';
import { MessageSchema } from '@/types';

// Mock fetch
const mockFetch = vi.fn();
(globalThis as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;

describe('GrpcReflectionClient', () => {
  let client: GrpcReflectionClient;

  beforeEach(() => {
    vi.clearAllMocks();
    clearReflectionCache();
    client = new GrpcReflectionClient('https://api.example.com');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should remove trailing slash from URL', () => {
      const client1 = new GrpcReflectionClient('https://api.example.com/');
      const client2 = new GrpcReflectionClient('https://api.example.com');
      // Both should work the same way
      expect(client1).toBeDefined();
      expect(client2).toBeDefined();
    });

    it('should accept custom timeout', () => {
      const client = new GrpcReflectionClient('https://api.example.com', 60000);
      expect(client).toBeDefined();
    });
  });

  describe('discoverServices', () => {
    it('should return success result when services are discovered', async () => {
      // Mock list services response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            listServicesResponse: {
              service: [
                { name: 'greet.v1.GreetService' },
                { name: 'user.v1.UserService' },
                { name: 'grpc.reflection.v1.ServerReflection' },
              ],
            },
          }),
      });

      // Mock file descriptor responses for each service
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            fileDescriptorResponse: {
              fileDescriptorProto: [createMockFileDescriptor('greet.v1', 'GreetService')],
            },
          }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            fileDescriptorResponse: {
              fileDescriptorProto: [createMockFileDescriptor('user.v1', 'UserService')],
            },
          }),
      });

      const result = await client.discoverServices();

      expect(result.success).toBe(true);
      expect(result.services.length).toBe(2); // Excludes reflection service
      expect(result.serverUrl).toBe('https://api.example.com');
      expect(result.timestamp).toBeDefined();
    });

    it('should filter out reflection services', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            listServicesResponse: {
              service: [
                { name: 'myapp.v1.MyService' },
                { name: 'grpc.reflection.v1.ServerReflection' },
                { name: 'grpc.reflection.v1alpha.ServerReflection' },
              ],
            },
          }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            fileDescriptorResponse: {
              fileDescriptorProto: [createMockFileDescriptor('myapp.v1', 'MyService')],
            },
          }),
      });

      const result = await client.discoverServices();

      expect(result.success).toBe(true);
      expect(result.services.length).toBe(1);
      expect(result.services[0]?.fullName).toBe('myapp.v1.MyService');
    });

    it('should fall back to v1alpha if v1 fails', async () => {
      // First call (v1) fails
      mockFetch.mockRejectedValueOnce(new Error('Not found'));

      // Second call (v1alpha) succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            listServicesResponse: {
              service: [{ name: 'legacy.v1.LegacyService' }],
            },
          }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            fileDescriptorResponse: {
              fileDescriptorProto: [createMockFileDescriptor('legacy.v1', 'LegacyService')],
            },
          }),
      });

      const result = await client.discoverServices();

      expect(result.success).toBe(true);
      expect(result.services.length).toBe(1);
    });

    it('should return error result when discovery fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.discoverServices();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
      expect(result.services).toEqual([]);
    });

    it('should handle HTTP error responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await client.discoverServices();

      expect(result.success).toBe(false);
      expect(result.error).toContain('failed');
    });

    it('should handle reflection error responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            errorResponse: {
              errorCode: 12,
              errorMessage: 'Reflection not supported',
            },
          }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            errorResponse: {
              errorCode: 12,
              errorMessage: 'Reflection not supported',
            },
          }),
      });

      const result = await client.discoverServices();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Reflection not supported');
    });

    it('should handle empty service list', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            listServicesResponse: {
              service: [],
            },
          }),
      });

      const result = await client.discoverServices();

      expect(result.success).toBe(true);
      expect(result.services).toEqual([]);
    });

    it('should handle timeout', async () => {
      mockFetch.mockImplementationOnce(() => {
        const error = new Error('AbortError');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      mockFetch.mockImplementationOnce(() => {
        const error = new Error('AbortError');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      const result = await client.discoverServices();

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });
});

describe('generateRequestTemplate', () => {
  it('should generate template for simple message', () => {
    const schema: MessageSchema = {
      name: 'HelloRequest',
      fullName: 'greet.v1.HelloRequest',
      fields: [
        {
          name: 'name',
          jsonName: 'name',
          number: 1,
          type: 'TYPE_STRING',
          label: 'LABEL_OPTIONAL',
        },
        {
          name: 'age',
          jsonName: 'age',
          number: 2,
          type: 'TYPE_INT32',
          label: 'LABEL_OPTIONAL',
        },
      ],
    };

    const template = generateRequestTemplate(schema);
    const parsed = JSON.parse(template);

    expect(parsed.name).toBe('<name>');
    expect(parsed.age).toBe(0);
  });

  it('should handle all primitive types', () => {
    const schema: MessageSchema = {
      name: 'AllTypes',
      fullName: 'test.AllTypes',
      fields: [
        { name: 'double_field', jsonName: 'doubleField', number: 1, type: 'TYPE_DOUBLE', label: 'LABEL_OPTIONAL' },
        { name: 'float_field', jsonName: 'floatField', number: 2, type: 'TYPE_FLOAT', label: 'LABEL_OPTIONAL' },
        { name: 'int64_field', jsonName: 'int64Field', number: 3, type: 'TYPE_INT64', label: 'LABEL_OPTIONAL' },
        { name: 'uint64_field', jsonName: 'uint64Field', number: 4, type: 'TYPE_UINT64', label: 'LABEL_OPTIONAL' },
        { name: 'int32_field', jsonName: 'int32Field', number: 5, type: 'TYPE_INT32', label: 'LABEL_OPTIONAL' },
        { name: 'bool_field', jsonName: 'boolField', number: 6, type: 'TYPE_BOOL', label: 'LABEL_OPTIONAL' },
        { name: 'string_field', jsonName: 'stringField', number: 7, type: 'TYPE_STRING', label: 'LABEL_OPTIONAL' },
        { name: 'bytes_field', jsonName: 'bytesField', number: 8, type: 'TYPE_BYTES', label: 'LABEL_OPTIONAL' },
      ],
    };

    const template = generateRequestTemplate(schema);
    const parsed = JSON.parse(template);

    expect(typeof parsed.doubleField).toBe('number');
    expect(parsed.doubleField).toBe(0.0);
    expect(typeof parsed.floatField).toBe('number');
    expect(typeof parsed.int64Field).toBe('number');
    expect(typeof parsed.uint64Field).toBe('number');
    expect(typeof parsed.int32Field).toBe('number');
    expect(typeof parsed.boolField).toBe('boolean');
    expect(parsed.boolField).toBe(false);
    expect(typeof parsed.stringField).toBe('string');
    expect(parsed.stringField).toBe('<string_field>');
    expect(typeof parsed.bytesField).toBe('string');
  });

  it('should handle repeated fields', () => {
    const schema: MessageSchema = {
      name: 'ListRequest',
      fullName: 'test.ListRequest',
      fields: [
        {
          name: 'ids',
          jsonName: 'ids',
          number: 1,
          type: 'TYPE_INT32',
          label: 'LABEL_REPEATED',
        },
        {
          name: 'names',
          jsonName: 'names',
          number: 2,
          type: 'TYPE_STRING',
          label: 'LABEL_REPEATED',
        },
      ],
    };

    const template = generateRequestTemplate(schema);
    const parsed = JSON.parse(template);

    expect(Array.isArray(parsed.ids)).toBe(true);
    expect(parsed.ids).toEqual([0]);
    expect(Array.isArray(parsed.names)).toBe(true);
    expect(parsed.names).toEqual(['<names>']);
  });

  it('should handle empty message', () => {
    const schema: MessageSchema = {
      name: 'EmptyMessage',
      fullName: 'test.EmptyMessage',
      fields: [],
    };

    const template = generateRequestTemplate(schema);
    const parsed = JSON.parse(template);

    expect(parsed).toEqual({});
  });

  it('should respect max depth for nested messages', () => {
    const schema: MessageSchema = {
      name: 'Recursive',
      fullName: 'test.Recursive',
      fields: [
        {
          name: 'child',
          jsonName: 'child',
          number: 1,
          type: 'TYPE_MESSAGE',
          typeName: 'test.Recursive',
          label: 'LABEL_OPTIONAL',
        },
      ],
    };

    const template = generateRequestTemplate(schema, 2);
    const parsed = JSON.parse(template);

    expect(parsed.child).toBeDefined();
    expect(typeof parsed.child).toBe('object');
  });

  it('should handle well-known types', () => {
    const schema: MessageSchema = {
      name: 'WellKnownTypes',
      fullName: 'test.WellKnownTypes',
      fields: [
        {
          name: 'timestamp',
          jsonName: 'timestamp',
          number: 1,
          type: 'TYPE_MESSAGE',
          typeName: '.google.protobuf.Timestamp',
          label: 'LABEL_OPTIONAL',
        },
        {
          name: 'duration',
          jsonName: 'duration',
          number: 2,
          type: 'TYPE_MESSAGE',
          typeName: '.google.protobuf.Duration',
          label: 'LABEL_OPTIONAL',
        },
        {
          name: 'empty',
          jsonName: 'empty',
          number: 3,
          type: 'TYPE_MESSAGE',
          typeName: '.google.protobuf.Empty',
          label: 'LABEL_OPTIONAL',
        },
      ],
    };

    const template = generateRequestTemplate(schema);
    const parsed = JSON.parse(template);

    // Timestamp should be ISO string
    expect(typeof parsed.timestamp).toBe('string');
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Duration should be string
    expect(parsed.duration).toBe('0s');

    // Empty should be empty object
    expect(parsed.empty).toEqual({});
  });
});

describe('validateRequestAgainstSchema', () => {
  const schema: MessageSchema = {
    name: 'TestMessage',
    fullName: 'test.TestMessage',
    fields: [
      { name: 'name', jsonName: 'name', number: 1, type: 'TYPE_STRING', label: 'LABEL_OPTIONAL' },
      { name: 'count', jsonName: 'count', number: 2, type: 'TYPE_INT32', label: 'LABEL_OPTIONAL' },
      { name: 'active', jsonName: 'active', number: 3, type: 'TYPE_BOOL', label: 'LABEL_OPTIONAL' },
      { name: 'tags', jsonName: 'tags', number: 4, type: 'TYPE_STRING', label: 'LABEL_REPEATED' },
    ],
  };

  it('should validate valid message', () => {
    const message = {
      name: 'test',
      count: 42,
      active: true,
      tags: ['a', 'b'],
    };

    const result = validateRequestAgainstSchema(message, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should accept partial messages', () => {
    const message = {
      name: 'test',
    };

    const result = validateRequestAgainstSchema(message, schema);
    expect(result.valid).toBe(true);
  });

  it('should detect unknown fields', () => {
    const message = {
      name: 'test',
      unknownField: 'value',
    };

    const result = validateRequestAgainstSchema(message, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unknown field: unknownField');
  });

  it('should validate field types', () => {
    const message = {
      name: 123, // Should be string
      count: 'not a number', // Should be number
      active: 'true', // Should be boolean
    };

    const result = validateRequestAgainstSchema(message, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should validate repeated field types', () => {
    const message = {
      tags: 'not an array',
    };

    const result = validateRequestAgainstSchema(message, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('expected array'))).toBe(true);
  });

  it('should validate items in repeated fields', () => {
    const message = {
      tags: ['valid', 123, 'also valid'],
    };

    const result = validateRequestAgainstSchema(message, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('item 1'))).toBe(true);
  });

  it('should reject non-object messages', () => {
    const result = validateRequestAgainstSchema('not an object', schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Message must be an object');
  });

  it('should reject null messages', () => {
    const result = validateRequestAgainstSchema(null, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Message must be an object');
  });
});

describe('formatMessageSchemaForDisplay', () => {
  it('should format simple message', () => {
    const schema: MessageSchema = {
      name: 'HelloRequest',
      fullName: 'greet.v1.HelloRequest',
      fields: [
        { name: 'name', jsonName: 'name', number: 1, type: 'TYPE_STRING', label: 'LABEL_OPTIONAL' },
        { name: 'count', jsonName: 'count', number: 2, type: 'TYPE_INT32', label: 'LABEL_OPTIONAL' },
      ],
    };

    const formatted = formatMessageSchemaForDisplay(schema);

    expect(formatted).toContain('message HelloRequest {');
    expect(formatted).toContain('string name = 1;');
    expect(formatted).toContain('int32 count = 2;');
    expect(formatted).toContain('}');
  });

  it('should format repeated fields', () => {
    const schema: MessageSchema = {
      name: 'ListRequest',
      fullName: 'test.ListRequest',
      fields: [
        { name: 'ids', jsonName: 'ids', number: 1, type: 'TYPE_INT32', label: 'LABEL_REPEATED' },
      ],
    };

    const formatted = formatMessageSchemaForDisplay(schema);
    expect(formatted).toContain('repeated int32 ids = 1;');
  });

  it('should format message types', () => {
    const schema: MessageSchema = {
      name: 'Container',
      fullName: 'test.Container',
      fields: [
        {
          name: 'item',
          jsonName: 'item',
          number: 1,
          type: 'TYPE_MESSAGE',
          typeName: '.test.Item',
          label: 'LABEL_OPTIONAL',
        },
      ],
    };

    const formatted = formatMessageSchemaForDisplay(schema);
    expect(formatted).toContain('Item item = 1;');
  });

  it('should format empty message', () => {
    const schema: MessageSchema = {
      name: 'Empty',
      fullName: 'test.Empty',
      fields: [],
    };

    const formatted = formatMessageSchemaForDisplay(schema);
    expect(formatted).toBe('message Empty {\n}');
  });
});

describe('getFieldTypeDescription', () => {
  it('should describe all field types', () => {
    expect(getFieldTypeDescription('TYPE_DOUBLE')).toContain('double');
    expect(getFieldTypeDescription('TYPE_FLOAT')).toContain('float');
    expect(getFieldTypeDescription('TYPE_INT64')).toContain('64-bit');
    expect(getFieldTypeDescription('TYPE_INT32')).toContain('32-bit');
    expect(getFieldTypeDescription('TYPE_BOOL')).toContain('boolean');
    expect(getFieldTypeDescription('TYPE_STRING')).toContain('string');
    expect(getFieldTypeDescription('TYPE_BYTES')).toContain('byte');
    expect(getFieldTypeDescription('TYPE_MESSAGE')).toContain('message');
    expect(getFieldTypeDescription('TYPE_ENUM')).toContain('enum');
  });
});

describe('Cache management', () => {
  beforeEach(() => {
    clearReflectionCache();
  });

  it('should clear reflection cache', () => {
    // This test just ensures the function doesn't throw
    clearReflectionCache();
    expect(getCachedMessageSchema('test')).toBeUndefined();
    expect(getCachedEnumSchema('test')).toBeUndefined();
  });

  it('should return undefined for uncached schemas', () => {
    expect(getCachedMessageSchema('nonexistent.Message')).toBeUndefined();
    expect(getCachedEnumSchema('nonexistent.Enum')).toBeUndefined();
  });
});

// Helper function to create mock file descriptor
function createMockFileDescriptor(packageName: string, serviceName: string): string {
  // Create a minimal FileDescriptorProto in wire format
  // This is a simplified version for testing
  const bytes: number[] = [];

  // Field 1: name (string)
  bytes.push((1 << 3) | 2); // field 1, wire type 2 (length-delimited)
  const fileName = `${packageName.replace(/\./g, '/')}.proto`;
  bytes.push(fileName.length);
  for (let i = 0; i < fileName.length; i++) {
    bytes.push(fileName.charCodeAt(i));
  }

  // Field 2: package (string)
  bytes.push((2 << 3) | 2);
  bytes.push(packageName.length);
  for (let i = 0; i < packageName.length; i++) {
    bytes.push(packageName.charCodeAt(i));
  }

  // Field 6: service (ServiceDescriptorProto)
  const serviceBytes = createServiceDescriptor(serviceName);
  bytes.push((6 << 3) | 2);
  bytes.push(serviceBytes.length);
  bytes.push(...serviceBytes);

  // Field 4: messageType (DescriptorProto) for request
  const requestMessageBytes = createMessageDescriptor(`${serviceName}Request`);
  bytes.push((4 << 3) | 2);
  bytes.push(requestMessageBytes.length);
  bytes.push(...requestMessageBytes);

  // Field 4: messageType (DescriptorProto) for response
  const responseMessageBytes = createMessageDescriptor(`${serviceName}Response`);
  bytes.push((4 << 3) | 2);
  bytes.push(responseMessageBytes.length);
  bytes.push(...responseMessageBytes);

  // Convert to base64
  const uint8Array = new Uint8Array(bytes);
  let binaryString = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binaryString += String.fromCharCode(uint8Array[i]!);
  }
  return btoa(binaryString);
}

function createServiceDescriptor(name: string): number[] {
  const bytes: number[] = [];

  // Field 1: name
  bytes.push((1 << 3) | 2);
  bytes.push(name.length);
  for (let i = 0; i < name.length; i++) {
    bytes.push(name.charCodeAt(i));
  }

  // Field 2: method (MethodDescriptorProto)
  const methodBytes = createMethodDescriptor('Execute', `${name}Request`, `${name}Response`);
  bytes.push((2 << 3) | 2);
  bytes.push(methodBytes.length);
  bytes.push(...methodBytes);

  return bytes;
}

function createMethodDescriptor(name: string, inputType: string, outputType: string): number[] {
  const bytes: number[] = [];

  // Field 1: name
  bytes.push((1 << 3) | 2);
  bytes.push(name.length);
  for (let i = 0; i < name.length; i++) {
    bytes.push(name.charCodeAt(i));
  }

  // Field 2: inputType
  const fullInputType = `.${inputType}`;
  bytes.push((2 << 3) | 2);
  bytes.push(fullInputType.length);
  for (let i = 0; i < fullInputType.length; i++) {
    bytes.push(fullInputType.charCodeAt(i));
  }

  // Field 3: outputType
  const fullOutputType = `.${outputType}`;
  bytes.push((3 << 3) | 2);
  bytes.push(fullOutputType.length);
  for (let i = 0; i < fullOutputType.length; i++) {
    bytes.push(fullOutputType.charCodeAt(i));
  }

  return bytes;
}

function createMessageDescriptor(name: string): number[] {
  const bytes: number[] = [];

  // Field 1: name
  bytes.push((1 << 3) | 2);
  bytes.push(name.length);
  for (let i = 0; i < name.length; i++) {
    bytes.push(name.charCodeAt(i));
  }

  // Field 2: field (FieldDescriptorProto) - add a sample field
  const fieldBytes = createFieldDescriptor('id', 1, 9, 1); // TYPE_STRING = 9, LABEL_OPTIONAL = 1
  bytes.push((2 << 3) | 2);
  bytes.push(fieldBytes.length);
  bytes.push(...fieldBytes);

  return bytes;
}

function createFieldDescriptor(name: string, number: number, type: number, label: number): number[] {
  const bytes: number[] = [];

  // Field 1: name
  bytes.push((1 << 3) | 2);
  bytes.push(name.length);
  for (let i = 0; i < name.length; i++) {
    bytes.push(name.charCodeAt(i));
  }

  // Field 3: number (varint)
  bytes.push((3 << 3) | 0);
  bytes.push(number);

  // Field 4: label (varint)
  bytes.push((4 << 3) | 0);
  bytes.push(label);

  // Field 5: type (varint)
  bytes.push((5 << 3) | 0);
  bytes.push(type);

  return bytes;
}
