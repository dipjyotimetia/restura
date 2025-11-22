/**
 * gRPC Server Reflection Client
 *
 * This module implements the gRPC Server Reflection Protocol to automatically
 * discover services and construct API requests based on the proto definitions.
 *
 * Supports:
 * - grpc.reflection.v1.ServerReflection (newer)
 * - grpc.reflection.v1alpha.ServerReflection (legacy)
 */

import {
  ReflectionServiceInfo,
  ReflectionMethodInfo,
  ReflectionResult,
  MessageSchema,
  FieldSchema,
  FieldType,
  FieldLabel,
  EnumSchema,
} from '@/types';
import { GrpcClientError } from './grpcClient';
import { GrpcStatusCode } from '@/types';
import { isElectron } from './platform';

// Reflection service constants
const REFLECTION_SERVICE_V1 = 'grpc.reflection.v1.ServerReflection';
const REFLECTION_SERVICE_V1_ALPHA = 'grpc.reflection.v1alpha.ServerReflection';

// Proto field type mapping
const PROTO_FIELD_TYPE_MAP: Record<number, FieldType> = {
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

const PROTO_FIELD_LABEL_MAP: Record<number, FieldLabel> = {
  1: 'LABEL_OPTIONAL',
  2: 'LABEL_REQUIRED',
  3: 'LABEL_REPEATED',
};

// Interface for raw reflection response
interface RawReflectionResponse {
  listServicesResponse?: {
    service: Array<{ name: string }>;
  };
  fileDescriptorResponse?: {
    fileDescriptorProto: string[]; // Base64 encoded FileDescriptorProto
  };
  errorResponse?: {
    errorCode: number;
    errorMessage: string;
  };
}

// Interface for parsed FileDescriptorProto
interface FileDescriptorProto {
  name?: string;
  package?: string;
  dependency?: string[];
  messageType?: DescriptorProto[];
  enumType?: EnumDescriptorProto[];
  service?: ServiceDescriptorProto[];
}

interface DescriptorProto {
  name?: string;
  field?: FieldDescriptorProto[];
  nestedType?: DescriptorProto[];
  enumType?: EnumDescriptorProto[];
  oneofDecl?: OneofDescriptorProto[];
}

interface FieldDescriptorProto {
  name?: string;
  number?: number;
  label?: number;
  type?: number;
  typeName?: string;
  defaultValue?: string;
  oneofIndex?: number;
  jsonName?: string;
}

interface EnumDescriptorProto {
  name?: string;
  value?: EnumValueDescriptorProto[];
}

interface EnumValueDescriptorProto {
  name?: string;
  number?: number;
}

interface ServiceDescriptorProto {
  name?: string;
  method?: MethodDescriptorProto[];
}

interface MethodDescriptorProto {
  name?: string;
  inputType?: string;
  outputType?: string;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
}

interface OneofDescriptorProto {
  name?: string;
}

// Cache limits to prevent memory leaks
const MAX_FILE_DESCRIPTOR_CACHE = 100;
const MAX_MESSAGE_SCHEMA_CACHE = 500;
const MAX_ENUM_SCHEMA_CACHE = 200;

// Cache for parsed file descriptors
const fileDescriptorCache = new Map<string, FileDescriptorProto>();
const messageSchemaCache = new Map<string, MessageSchema>();
const enumSchemaCache = new Map<string, EnumSchema>();

// Helper to add to cache with size limit (simple LRU-like behavior)
function addToCache<T>(cache: Map<string, T>, key: string, value: T, maxSize: number): void {
  // If cache is full, remove oldest entries (first 10%)
  if (cache.size >= maxSize) {
    const keysToDelete = Array.from(cache.keys()).slice(0, Math.ceil(maxSize * 0.1));
    keysToDelete.forEach(k => cache.delete(k));
  }
  cache.set(key, value);
}

/**
 * Main reflection client class
 */
export class GrpcReflectionClient {
  private baseUrl: string;
  private reflectionVersion: 'v1' | 'v1alpha' = 'v1';
  private timeout: number;

  constructor(baseUrl: string, timeout: number = 30000) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = timeout;
  }

  /**
   * Discover all services available on the gRPC server
   */
  async discoverServices(): Promise<ReflectionResult> {
    try {
      // Try v1 first, then fall back to v1alpha
      let services: string[];
      try {
        services = await this.listServices(REFLECTION_SERVICE_V1);
        this.reflectionVersion = 'v1';
      } catch {
        services = await this.listServices(REFLECTION_SERVICE_V1_ALPHA);
        this.reflectionVersion = 'v1alpha';
      }

      // Filter out reflection service itself
      const userServices = services.filter(
        (s) => !s.startsWith('grpc.reflection.')
      );

      // Get detailed info for each service
      const serviceInfos: ReflectionServiceInfo[] = [];
      for (const serviceName of userServices) {
        try {
          const serviceInfo = await this.getServiceInfo(serviceName);
          serviceInfos.push(serviceInfo);
        } catch (error) {
          console.warn(`Failed to get info for service ${serviceName}:`, error);
        }
      }

      return {
        success: true,
        services: serviceInfos,
        serverUrl: this.baseUrl,
        timestamp: Date.now(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to discover services';
      return {
        success: false,
        services: [],
        error: errorMessage,
        serverUrl: this.baseUrl,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * List all services using the reflection API
   */
  private async listServices(reflectionServiceName: string): Promise<string[]> {
    const request = {
      listServices: '',
    };

    const response = await this.sendReflectionRequest(reflectionServiceName, request);

    if (response.errorResponse) {
      throw new GrpcClientError(
        response.errorResponse.errorMessage,
        response.errorResponse.errorCode as GrpcStatusCode
      );
    }

    if (!response.listServicesResponse) {
      throw new GrpcClientError(
        'Invalid reflection response: missing listServicesResponse',
        GrpcStatusCode.INTERNAL
      );
    }

    return response.listServicesResponse.service.map((s) => s.name);
  }

  /**
   * Get detailed service information including methods and message schemas
   */
  private async getServiceInfo(serviceName: string): Promise<ReflectionServiceInfo> {
    const reflectionServiceName =
      this.reflectionVersion === 'v1' ? REFLECTION_SERVICE_V1 : REFLECTION_SERVICE_V1_ALPHA;

    const request = {
      fileContainingSymbol: serviceName,
    };

    const response = await this.sendReflectionRequest(reflectionServiceName, request);

    if (response.errorResponse) {
      throw new GrpcClientError(
        response.errorResponse.errorMessage,
        response.errorResponse.errorCode as GrpcStatusCode
      );
    }

    if (!response.fileDescriptorResponse) {
      throw new GrpcClientError(
        'Invalid reflection response: missing fileDescriptorResponse',
        GrpcStatusCode.INTERNAL
      );
    }

    // Parse file descriptors
    const fileDescriptors: FileDescriptorProto[] = [];
    for (const encodedProto of response.fileDescriptorResponse.fileDescriptorProto) {
      const descriptor = this.parseFileDescriptor(encodedProto);
      fileDescriptors.push(descriptor);

      // Cache the descriptor
      if (descriptor.name) {
        addToCache(fileDescriptorCache, descriptor.name, descriptor, MAX_FILE_DESCRIPTOR_CACHE);
      }

      // Cache message and enum schemas
      this.cacheMessageTypes(descriptor);
    }

    // Find the service definition
    for (const fd of fileDescriptors) {
      if (fd.service) {
        for (const svc of fd.service) {
          const fullName = fd.package ? `${fd.package}.${svc.name}` : svc.name || '';
          if (fullName === serviceName || svc.name === serviceName) {
            return this.buildServiceInfo(svc, fd.package || '');
          }
        }
      }
    }

    throw new GrpcClientError(
      `Service ${serviceName} not found in file descriptors`,
      GrpcStatusCode.NOT_FOUND
    );
  }

  /**
   * Send a reflection request to the server
   */
  private async sendReflectionRequest(
    reflectionServiceName: string,
    request: unknown
  ): Promise<RawReflectionResponse> {
    // In web mode, use the Next.js proxy to avoid CORS issues
    if (!isElectron()) {
      return this.sendReflectionRequestViaProxy(request);
    }

    // In Electron mode, make direct request
    const path = `/${reflectionServiceName}/ServerReflectionInfo`;
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new GrpcClientError(
          `Reflection request failed: ${response.statusText}`,
          this.httpStatusToGrpcStatus(response.status)
        );
      }

      const responseData = await response.json();
      return responseData as RawReflectionResponse;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof GrpcClientError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GrpcClientError(
          'Reflection request timed out',
          GrpcStatusCode.DEADLINE_EXCEEDED
        );
      }
      throw new GrpcClientError(
        `Failed to connect to reflection service: ${error instanceof Error ? error.message : 'Unknown error'}`,
        GrpcStatusCode.UNAVAILABLE
      );
    }
  }

  /**
   * Send reflection request via Next.js proxy (for web mode)
   */
  private async sendReflectionRequestViaProxy(
    request: unknown
  ): Promise<RawReflectionResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch('/api/grpc/reflection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: this.baseUrl,
          request,
          timeout: this.timeout,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new GrpcClientError(
          errorData.error || `Reflection request failed: ${response.statusText}`,
          this.httpStatusToGrpcStatus(response.status)
        );
      }

      const responseData = await response.json();

      // Check for error in response
      if (responseData.error) {
        throw new GrpcClientError(
          responseData.error,
          GrpcStatusCode.INTERNAL
        );
      }

      return responseData as RawReflectionResponse;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof GrpcClientError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GrpcClientError(
          'Reflection request timed out',
          GrpcStatusCode.DEADLINE_EXCEEDED
        );
      }
      throw new GrpcClientError(
        `Failed to connect to reflection service: ${error instanceof Error ? error.message : 'Unknown error'}`,
        GrpcStatusCode.UNAVAILABLE
      );
    }
  }

  /**
   * Parse a base64-encoded FileDescriptorProto
   */
  private parseFileDescriptor(encodedProto: string): FileDescriptorProto {
    // Decode base64
    const binaryString = atob(encodedProto);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Parse protobuf wire format
    // This is a simplified parser that handles the most common cases
    return this.parseProtoWireFormat(bytes);
  }

  /**
   * Parse protobuf wire format into FileDescriptorProto
   * This is a simplified implementation for common proto structures
   */
  private parseProtoWireFormat(bytes: Uint8Array): FileDescriptorProto {
    const result: FileDescriptorProto = {
      dependency: [],
      messageType: [],
      enumType: [],
      service: [],
    };

    let offset = 0;

    while (offset < bytes.length) {
      const tag = this.readVarint(bytes, offset);
      offset = tag.newOffset;

      const fieldNumber = tag.value >> 3;
      const wireType = tag.value & 0x7;

      switch (fieldNumber) {
        case 1: // name
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.name = str.value;
            offset = str.newOffset;
          }
          break;

        case 2: // package
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.package = str.value;
            offset = str.newOffset;
          }
          break;

        case 3: // dependency
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.dependency!.push(str.value);
            offset = str.newOffset;
          }
          break;

        case 4: // messageType
          if (wireType === 2) {
            const msg = this.readLengthDelimited(bytes, offset);
            const descriptor = this.parseDescriptorProto(msg.value);
            result.messageType!.push(descriptor);
            offset = msg.newOffset;
          }
          break;

        case 5: // enumType
          if (wireType === 2) {
            const msg = this.readLengthDelimited(bytes, offset);
            const enumDesc = this.parseEnumDescriptorProto(msg.value);
            result.enumType!.push(enumDesc);
            offset = msg.newOffset;
          }
          break;

        case 6: // service
          if (wireType === 2) {
            const msg = this.readLengthDelimited(bytes, offset);
            const serviceDesc = this.parseServiceDescriptorProto(msg.value);
            result.service!.push(serviceDesc);
            offset = msg.newOffset;
          }
          break;

        default:
          // Skip unknown fields
          offset = this.skipField(bytes, offset, wireType);
          break;
      }
    }

    return result;
  }

  /**
   * Parse a DescriptorProto (message definition)
   */
  private parseDescriptorProto(bytes: Uint8Array): DescriptorProto {
    const result: DescriptorProto = {
      field: [],
      nestedType: [],
      enumType: [],
      oneofDecl: [],
    };

    let offset = 0;

    while (offset < bytes.length) {
      const tag = this.readVarint(bytes, offset);
      offset = tag.newOffset;

      const fieldNumber = tag.value >> 3;
      const wireType = tag.value & 0x7;

      switch (fieldNumber) {
        case 1: // name
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.name = str.value;
            offset = str.newOffset;
          }
          break;

        case 2: // field
          if (wireType === 2) {
            const msg = this.readLengthDelimited(bytes, offset);
            const field = this.parseFieldDescriptorProto(msg.value);
            result.field!.push(field);
            offset = msg.newOffset;
          }
          break;

        case 3: // nestedType
          if (wireType === 2) {
            const msg = this.readLengthDelimited(bytes, offset);
            const nested = this.parseDescriptorProto(msg.value);
            result.nestedType!.push(nested);
            offset = msg.newOffset;
          }
          break;

        case 4: // enumType
          if (wireType === 2) {
            const msg = this.readLengthDelimited(bytes, offset);
            const enumDesc = this.parseEnumDescriptorProto(msg.value);
            result.enumType!.push(enumDesc);
            offset = msg.newOffset;
          }
          break;

        case 8: // oneofDecl
          if (wireType === 2) {
            const msg = this.readLengthDelimited(bytes, offset);
            const oneof = this.parseOneofDescriptorProto(msg.value);
            result.oneofDecl!.push(oneof);
            offset = msg.newOffset;
          }
          break;

        default:
          offset = this.skipField(bytes, offset, wireType);
          break;
      }
    }

    return result;
  }

  /**
   * Parse a FieldDescriptorProto
   */
  private parseFieldDescriptorProto(bytes: Uint8Array): FieldDescriptorProto {
    const result: FieldDescriptorProto = {};
    let offset = 0;

    while (offset < bytes.length) {
      const tag = this.readVarint(bytes, offset);
      offset = tag.newOffset;

      const fieldNumber = tag.value >> 3;
      const wireType = tag.value & 0x7;

      switch (fieldNumber) {
        case 1: // name
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.name = str.value;
            offset = str.newOffset;
          }
          break;

        case 3: // number
          if (wireType === 0) {
            const num = this.readVarint(bytes, offset);
            result.number = num.value;
            offset = num.newOffset;
          }
          break;

        case 4: // label
          if (wireType === 0) {
            const label = this.readVarint(bytes, offset);
            result.label = label.value;
            offset = label.newOffset;
          }
          break;

        case 5: // type
          if (wireType === 0) {
            const type = this.readVarint(bytes, offset);
            result.type = type.value;
            offset = type.newOffset;
          }
          break;

        case 6: // typeName
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.typeName = str.value;
            offset = str.newOffset;
          }
          break;

        case 7: // defaultValue
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.defaultValue = str.value;
            offset = str.newOffset;
          }
          break;

        case 9: // oneofIndex
          if (wireType === 0) {
            const idx = this.readVarint(bytes, offset);
            result.oneofIndex = idx.value;
            offset = idx.newOffset;
          }
          break;

        case 10: // jsonName
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.jsonName = str.value;
            offset = str.newOffset;
          }
          break;

        default:
          offset = this.skipField(bytes, offset, wireType);
          break;
      }
    }

    return result;
  }

  /**
   * Parse an EnumDescriptorProto
   */
  private parseEnumDescriptorProto(bytes: Uint8Array): EnumDescriptorProto {
    const result: EnumDescriptorProto = {
      value: [],
    };
    let offset = 0;

    while (offset < bytes.length) {
      const tag = this.readVarint(bytes, offset);
      offset = tag.newOffset;

      const fieldNumber = tag.value >> 3;
      const wireType = tag.value & 0x7;

      switch (fieldNumber) {
        case 1: // name
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.name = str.value;
            offset = str.newOffset;
          }
          break;

        case 2: // value
          if (wireType === 2) {
            const msg = this.readLengthDelimited(bytes, offset);
            const enumValue = this.parseEnumValueDescriptorProto(msg.value);
            result.value!.push(enumValue);
            offset = msg.newOffset;
          }
          break;

        default:
          offset = this.skipField(bytes, offset, wireType);
          break;
      }
    }

    return result;
  }

  /**
   * Parse an EnumValueDescriptorProto
   */
  private parseEnumValueDescriptorProto(bytes: Uint8Array): EnumValueDescriptorProto {
    const result: EnumValueDescriptorProto = {};
    let offset = 0;

    while (offset < bytes.length) {
      const tag = this.readVarint(bytes, offset);
      offset = tag.newOffset;

      const fieldNumber = tag.value >> 3;
      const wireType = tag.value & 0x7;

      switch (fieldNumber) {
        case 1: // name
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.name = str.value;
            offset = str.newOffset;
          }
          break;

        case 2: // number
          if (wireType === 0) {
            const num = this.readVarint(bytes, offset);
            result.number = num.value;
            offset = num.newOffset;
          }
          break;

        default:
          offset = this.skipField(bytes, offset, wireType);
          break;
      }
    }

    return result;
  }

  /**
   * Parse a ServiceDescriptorProto
   */
  private parseServiceDescriptorProto(bytes: Uint8Array): ServiceDescriptorProto {
    const result: ServiceDescriptorProto = {
      method: [],
    };
    let offset = 0;

    while (offset < bytes.length) {
      const tag = this.readVarint(bytes, offset);
      offset = tag.newOffset;

      const fieldNumber = tag.value >> 3;
      const wireType = tag.value & 0x7;

      switch (fieldNumber) {
        case 1: // name
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.name = str.value;
            offset = str.newOffset;
          }
          break;

        case 2: // method
          if (wireType === 2) {
            const msg = this.readLengthDelimited(bytes, offset);
            const method = this.parseMethodDescriptorProto(msg.value);
            result.method!.push(method);
            offset = msg.newOffset;
          }
          break;

        default:
          offset = this.skipField(bytes, offset, wireType);
          break;
      }
    }

    return result;
  }

  /**
   * Parse a MethodDescriptorProto
   */
  private parseMethodDescriptorProto(bytes: Uint8Array): MethodDescriptorProto {
    const result: MethodDescriptorProto = {
      clientStreaming: false,
      serverStreaming: false,
    };
    let offset = 0;

    while (offset < bytes.length) {
      const tag = this.readVarint(bytes, offset);
      offset = tag.newOffset;

      const fieldNumber = tag.value >> 3;
      const wireType = tag.value & 0x7;

      switch (fieldNumber) {
        case 1: // name
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.name = str.value;
            offset = str.newOffset;
          }
          break;

        case 2: // inputType
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.inputType = str.value;
            offset = str.newOffset;
          }
          break;

        case 3: // outputType
          if (wireType === 2) {
            const str = this.readString(bytes, offset);
            result.outputType = str.value;
            offset = str.newOffset;
          }
          break;

        case 5: // clientStreaming
          if (wireType === 0) {
            const val = this.readVarint(bytes, offset);
            result.clientStreaming = val.value !== 0;
            offset = val.newOffset;
          }
          break;

        case 6: // serverStreaming
          if (wireType === 0) {
            const val = this.readVarint(bytes, offset);
            result.serverStreaming = val.value !== 0;
            offset = val.newOffset;
          }
          break;

        default:
          offset = this.skipField(bytes, offset, wireType);
          break;
      }
    }

    return result;
  }

  /**
   * Parse an OneofDescriptorProto
   */
  private parseOneofDescriptorProto(bytes: Uint8Array): OneofDescriptorProto {
    const result: OneofDescriptorProto = {};
    let offset = 0;

    while (offset < bytes.length) {
      const tag = this.readVarint(bytes, offset);
      offset = tag.newOffset;

      const fieldNumber = tag.value >> 3;
      const wireType = tag.value & 0x7;

      if (fieldNumber === 1 && wireType === 2) {
        const str = this.readString(bytes, offset);
        result.name = str.value;
        offset = str.newOffset;
      } else {
        offset = this.skipField(bytes, offset, wireType);
      }
    }

    return result;
  }

  // Protobuf wire format helpers

  private readVarint(bytes: Uint8Array, offset: number): { value: number; newOffset: number } {
    let value = 0;
    let shift = 0;
    let currentOffset = offset;

    while (currentOffset < bytes.length) {
      const byte = bytes[currentOffset]!;
      value |= (byte & 0x7f) << shift;
      currentOffset++;

      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
    }

    return { value, newOffset: currentOffset };
  }

  private readString(bytes: Uint8Array, offset: number): { value: string; newOffset: number } {
    const length = this.readVarint(bytes, offset);
    const stringBytes = bytes.slice(length.newOffset, length.newOffset + length.value);
    const decoder = new TextDecoder();
    const value = decoder.decode(stringBytes);
    return { value, newOffset: length.newOffset + length.value };
  }

  private readLengthDelimited(
    bytes: Uint8Array,
    offset: number
  ): { value: Uint8Array; newOffset: number } {
    const length = this.readVarint(bytes, offset);
    const value = bytes.slice(length.newOffset, length.newOffset + length.value);
    return { value, newOffset: length.newOffset + length.value };
  }

  private skipField(bytes: Uint8Array, offset: number, wireType: number): number {
    switch (wireType) {
      case 0: // Varint
        return this.readVarint(bytes, offset).newOffset;
      case 1: // 64-bit
        return offset + 8;
      case 2: // Length-delimited
        const length = this.readVarint(bytes, offset);
        return length.newOffset + length.value;
      case 5: // 32-bit
        return offset + 4;
      default:
        return offset;
    }
  }

  /**
   * Cache message and enum types from a FileDescriptorProto
   */
  private cacheMessageTypes(fd: FileDescriptorProto): void {
    const packageName = fd.package || '';

    // Cache top-level messages
    if (fd.messageType) {
      for (const msgType of fd.messageType) {
        this.cacheMessageType(msgType, packageName);
      }
    }

    // Cache top-level enums
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

  /**
   * Cache a single message type and its nested types
   */
  private cacheMessageType(msgType: DescriptorProto, parentName: string): void {
    const fullName = parentName ? `${parentName}.${msgType.name}` : msgType.name || '';

    const fields: FieldSchema[] =
      msgType.field?.map((f) => ({
        name: f.name || '',
        jsonName: f.jsonName || this.toJsonName(f.name || ''),
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

    // Cache nested messages
    if (msgType.nestedType) {
      for (const nested of msgType.nestedType) {
        this.cacheMessageType(nested, fullName);
      }
    }

    // Cache nested enums
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

  /**
   * Convert proto field name to JSON field name
   */
  private toJsonName(protoName: string): string {
    return protoName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  /**
   * Build ReflectionServiceInfo from ServiceDescriptorProto
   */
  private buildServiceInfo(
    svc: ServiceDescriptorProto,
    packageName: string
  ): ReflectionServiceInfo {
    const fullName = packageName ? `${packageName}.${svc.name}` : svc.name || '';

    const methods: ReflectionMethodInfo[] =
      svc.method?.map((method) => {
        const inputSchema = this.getMessageSchema(method.inputType || '');
        const outputSchema = this.getMessageSchema(method.outputType || '');

        return {
          name: method.name || '',
          fullName: `${fullName}/${method.name}`,
          inputType: method.inputType || '',
          outputType: method.outputType || '',
          clientStreaming: method.clientStreaming || false,
          serverStreaming: method.serverStreaming || false,
          inputMessageSchema: inputSchema,
          outputMessageSchema: outputSchema,
        };
      }) || [];

    return {
      name: svc.name || '',
      fullName,
      methods,
    };
  }

  /**
   * Get a MessageSchema from cache
   */
  private getMessageSchema(typeName: string): MessageSchema {
    const cached = messageSchemaCache.get(typeName);
    if (cached) {
      return cached;
    }

    // Return a placeholder if not found
    return {
      name: typeName.split('.').pop() || typeName,
      fullName: typeName,
      fields: [],
    };
  }

  /**
   * Convert HTTP status to gRPC status
   */
  private httpStatusToGrpcStatus(httpStatus: number): GrpcStatusCode {
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
      case 500:
        return GrpcStatusCode.INTERNAL;
      case 501:
        return GrpcStatusCode.UNIMPLEMENTED;
      case 503:
        return GrpcStatusCode.UNAVAILABLE;
      case 504:
        return GrpcStatusCode.DEADLINE_EXCEEDED;
      default:
        return GrpcStatusCode.UNKNOWN;
    }
  }
}

/**
 * Generate a JSON request template from a MessageSchema
 */
export function generateRequestTemplate(schema: MessageSchema, maxDepth: number = 5): string {
  const template = generateTemplateObject(schema, maxDepth, 0, new Set());
  return JSON.stringify(template, null, 2);
}

/**
 * Generate a template object from a MessageSchema
 */
function generateTemplateObject(
  schema: MessageSchema,
  maxDepth: number,
  currentDepth: number,
  visited: Set<string>
): Record<string, unknown> {
  if (currentDepth >= maxDepth || visited.has(schema.fullName)) {
    return {};
  }

  visited.add(schema.fullName);
  const result: Record<string, unknown> = {};

  for (const field of schema.fields) {
    const fieldValue = generateFieldValue(field, maxDepth, currentDepth + 1, new Set(visited));

    if (field.label === 'LABEL_REPEATED') {
      result[field.jsonName] = [fieldValue];
    } else {
      result[field.jsonName] = fieldValue;
    }
  }

  visited.delete(schema.fullName);
  return result;
}

/**
 * Generate a default value for a field
 */
function generateFieldValue(
  field: FieldSchema,
  maxDepth: number,
  currentDepth: number,
  visited: Set<string>
): unknown {
  // Handle maps (represented as repeated with special key/value structure)
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

    case 'TYPE_ENUM':
      const enumSchema = enumSchemaCache.get(field.typeName || '');
      if (enumSchema && enumSchema.values.length > 0) {
        return enumSchema.values[0]!.name;
      }
      return 0;

    case 'TYPE_MESSAGE':
      if (field.typeName) {
        // Handle well-known types
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
        if (nestedSchema) {
          return generateTemplateObject(nestedSchema, maxDepth, currentDepth, visited);
        }
      }
      return {};

    case 'TYPE_GROUP':
      return {};

    default:
      return null;
  }
}

/**
 * Get field type description for documentation
 */
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

/**
 * Validate a request message against its schema
 */
export function validateRequestAgainstSchema(
  message: unknown,
  schema: MessageSchema
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof message !== 'object' || message === null) {
    return { valid: false, errors: ['Message must be an object'] };
  }

  const messageObj = message as Record<string, unknown>;

  // Check for unknown fields
  const knownFields = new Set(schema.fields.map((f) => f.jsonName));
  for (const key of Object.keys(messageObj)) {
    if (!knownFields.has(key)) {
      errors.push(`Unknown field: ${key}`);
    }
  }

  // Validate each field
  for (const field of schema.fields) {
    const value = messageObj[field.jsonName];

    // Check required fields
    if (field.label === 'LABEL_REQUIRED' && value === undefined) {
      errors.push(`Missing required field: ${field.jsonName}`);
      continue;
    }

    if (value === undefined) {
      continue;
    }

    // Validate type
    const typeError = validateFieldType(value, field);
    if (typeError) {
      errors.push(`Field ${field.jsonName}: ${typeError}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a field value against its expected type
 */
function validateFieldType(value: unknown, field: FieldSchema): string | null {
  // Handle repeated fields
  if (field.label === 'LABEL_REPEATED') {
    if (!Array.isArray(value)) {
      return 'expected array';
    }
    for (let i = 0; i < value.length; i++) {
      const itemError = validateSingleFieldType(value[i], field);
      if (itemError) {
        return `item ${i}: ${itemError}`;
      }
    }
    return null;
  }

  return validateSingleFieldType(value, field);
}

/**
 * Validate a single field value against its expected type
 */
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
      if (typeof value !== 'number' && typeof value !== 'string') {
        return 'expected number';
      }
      break;

    case 'TYPE_BOOL':
      if (typeof value !== 'boolean') {
        return 'expected boolean';
      }
      break;

    case 'TYPE_STRING':
    case 'TYPE_BYTES':
      if (typeof value !== 'string') {
        return 'expected string';
      }
      break;

    case 'TYPE_ENUM':
      if (typeof value !== 'string' && typeof value !== 'number') {
        return 'expected string or number';
      }
      break;

    case 'TYPE_MESSAGE':
      if (typeof value !== 'object' || value === null) {
        return 'expected object';
      }
      break;
  }

  return null;
}

/**
 * Format a MessageSchema for display
 */
export function formatMessageSchemaForDisplay(schema: MessageSchema): string {
  const lines: string[] = [`message ${schema.name} {`];

  for (const field of schema.fields) {
    const label = field.label === 'LABEL_REPEATED' ? 'repeated ' : field.label === 'LABEL_REQUIRED' ? 'required ' : '';
    const type = field.type === 'TYPE_MESSAGE' || field.type === 'TYPE_ENUM' ? field.typeName?.split('.').pop() || field.type : getProtoTypeName(field.type);
    lines.push(`  ${label}${type} ${field.name} = ${field.number};`);
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Get proto type name from FieldType
 */
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

/**
 * Clear the reflection caches
 */
export function clearReflectionCache(): void {
  fileDescriptorCache.clear();
  messageSchemaCache.clear();
  enumSchemaCache.clear();
}

/**
 * Get cached message schema
 */
export function getCachedMessageSchema(typeName: string): MessageSchema | undefined {
  return messageSchemaCache.get(typeName);
}

/**
 * Get cached enum schema
 */
export function getCachedEnumSchema(typeName: string): EnumSchema | undefined {
  return enumSchemaCache.get(typeName);
}

/**
 * Generate proto content from reflection data
 * This creates a minimal .proto file that can be used by grpc-handler
 */
export function generateProtoFromReflection(
  serviceName: string,
  serviceInfo: ReflectionServiceInfo
): string {
  const lines: string[] = [];

  // Add syntax declaration
  lines.push('syntax = "proto3";');
  lines.push('');

  // Extract package name from service full name
  const packageParts = serviceName.split('.');
  const serviceShortName = packageParts.pop() || serviceName;
  const packageName = packageParts.join('.');

  if (packageName) {
    lines.push(`package ${packageName};`);
    lines.push('');
  }

  // Collect all message types needed
  const messageTypes = new Set<string>();
  for (const method of serviceInfo.methods) {
    if (method.inputMessageSchema) {
      collectMessageTypes(method.inputMessageSchema, messageTypes);
    }
    if (method.outputMessageSchema) {
      collectMessageTypes(method.outputMessageSchema, messageTypes);
    }
  }

  // Generate message definitions
  for (const typeName of messageTypes) {
    const schema = messageSchemaCache.get(typeName);
    if (schema) {
      lines.push(generateMessageDefinition(schema));
      lines.push('');
    }
  }

  // Generate service definition
  lines.push(`service ${serviceShortName} {`);
  for (const method of serviceInfo.methods) {
    const inputType = method.inputType.split('.').pop() || method.inputType;
    const outputType = method.outputType.split('.').pop() || method.outputType;
    const clientStream = method.clientStreaming ? 'stream ' : '';
    const serverStream = method.serverStreaming ? 'stream ' : '';
    lines.push(`  rpc ${method.name} (${clientStream}${inputType}) returns (${serverStream}${outputType});`);
  }
  lines.push('}');

  return lines.join('\n');
}

/**
 * Collect all message types recursively
 */
function collectMessageTypes(schema: MessageSchema, types: Set<string>): void {
  if (types.has(schema.fullName)) {
    return;
  }
  types.add(schema.fullName);

  for (const field of schema.fields) {
    if (field.type === 'TYPE_MESSAGE' && field.typeName) {
      const nestedSchema = messageSchemaCache.get(field.typeName);
      if (nestedSchema) {
        collectMessageTypes(nestedSchema, types);
      }
    }
  }
}

/**
 * Generate a single message definition
 */
function generateMessageDefinition(schema: MessageSchema): string {
  const lines: string[] = [`message ${schema.name} {`];

  for (const field of schema.fields) {
    const label = field.label === 'LABEL_REPEATED' ? 'repeated ' : '';
    let type: string;

    if (field.type === 'TYPE_MESSAGE' || field.type === 'TYPE_ENUM') {
      type = field.typeName?.split('.').pop() || 'string';
    } else {
      type = getProtoTypeName(field.type);
    }

    lines.push(`  ${label}${type} ${field.name} = ${field.number};`);
  }

  lines.push('}');
  return lines.join('\n');
}
