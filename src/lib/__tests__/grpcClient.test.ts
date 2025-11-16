import { describe, it, expect } from 'vitest';
import {
  buildAuthMetadata,
  parseProtoFile,
  validateGrpcUrl,
  validateServiceName,
  validateMethodName,
  prepareGrpcRequest,
  createErrorResponse,
  createSuccessResponse,
  httpStatusToGrpcStatus,
  buildGrpcPath,
  formatGrpcStatus,
  isGrpcError,
  getSuggestedAction,
  getMethodTypeDescription,
  GrpcClientError,
} from '../grpcClient';
import { GrpcRequest, GrpcStatusCode, AuthConfig } from '@/types';

describe('grpcClient', () => {
  describe('buildAuthMetadata', () => {
    it('should return empty object for no auth', () => {
      const auth: AuthConfig = { type: 'none' };
      const result = buildAuthMetadata(auth);
      expect(result).toEqual({});
    });

    it('should build bearer token metadata', () => {
      const auth: AuthConfig = {
        type: 'bearer',
        bearer: { token: 'test-token-123' },
      };
      const result = buildAuthMetadata(auth);
      expect(result).toEqual({
        authorization: 'Bearer test-token-123',
      });
    });

    it('should build basic auth metadata', () => {
      const auth: AuthConfig = {
        type: 'basic',
        basic: { username: 'user', password: 'pass' },
      };
      const result = buildAuthMetadata(auth);
      const expectedCreds = btoa('user:pass');
      expect(result).toEqual({
        authorization: `Basic ${expectedCreds}`,
      });
    });

    it('should build api-key auth metadata for header', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        apiKey: { key: 'x-api-key', value: 'secret-key', in: 'header' },
      };
      const result = buildAuthMetadata(auth);
      expect(result).toEqual({
        'x-api-key': 'secret-key',
      });
    });

    it('should not add api-key for query type', () => {
      const auth: AuthConfig = {
        type: 'api-key',
        apiKey: { key: 'api_key', value: 'secret-key', in: 'query' },
      };
      const result = buildAuthMetadata(auth);
      expect(result).toEqual({});
    });

    it('should build oauth2 metadata with custom token type', () => {
      const auth: AuthConfig = {
        type: 'oauth2',
        oauth2: { accessToken: 'oauth-token', tokenType: 'MAC' },
      };
      const result = buildAuthMetadata(auth);
      expect(result).toEqual({
        authorization: 'MAC oauth-token',
      });
    });

    it('should build oauth2 metadata with default Bearer type', () => {
      const auth: AuthConfig = {
        type: 'oauth2',
        oauth2: { accessToken: 'oauth-token' },
      };
      const result = buildAuthMetadata(auth);
      expect(result).toEqual({
        authorization: 'Bearer oauth-token',
      });
    });

    it('should handle digest auth', () => {
      const auth: AuthConfig = {
        type: 'digest',
        digest: { username: 'user', password: 'pass' },
      };
      const result = buildAuthMetadata(auth);
      expect(result).toEqual({
        'x-digest-username': 'user',
        'x-digest-password': 'pass',
      });
    });

    it('should handle AWS signature auth', () => {
      const auth: AuthConfig = {
        type: 'aws-signature',
        awsSignature: {
          accessKey: 'AKIAIOSFODNN7EXAMPLE',
          secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          region: 'us-east-1',
          service: 's3',
        },
      };
      const result = buildAuthMetadata(auth);
      expect(result).toEqual({
        'x-aws-access-key': 'AKIAIOSFODNN7EXAMPLE',
        'x-aws-region': 'us-east-1',
        'x-aws-service': 's3',
      });
    });
  });

  describe('validateGrpcUrl', () => {
    it('should validate https URL', () => {
      const result = validateGrpcUrl('https://api.example.com');
      expect(result.valid).toBe(true);
    });

    it('should validate http URL', () => {
      const result = validateGrpcUrl('http://localhost:8080');
      expect(result.valid).toBe(true);
    });

    it('should reject empty URL', () => {
      const result = validateGrpcUrl('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('URL is required');
    });

    it('should reject non-http URL', () => {
      const result = validateGrpcUrl('grpc://api.example.com');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('http://');
    });

    it('should reject invalid URL format', () => {
      const result = validateGrpcUrl('not a valid url');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateServiceName', () => {
    it('should validate correct service name', () => {
      const result = validateServiceName('greet.v1.GreetService');
      expect(result.valid).toBe(true);
    });

    it('should validate simple service name', () => {
      const result = validateServiceName('package.Service');
      expect(result.valid).toBe(true);
    });

    it('should reject empty service name', () => {
      const result = validateServiceName('');
      expect(result.valid).toBe(false);
    });

    it('should reject service without package', () => {
      const result = validateServiceName('GreetService');
      expect(result.valid).toBe(false);
    });

    it('should reject service with invalid characters', () => {
      const result = validateServiceName('greet-v1.GreetService');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateMethodName', () => {
    it('should validate PascalCase method name', () => {
      const result = validateMethodName('SayHello');
      expect(result.valid).toBe(true);
    });

    it('should validate simple method name', () => {
      const result = validateMethodName('Greet');
      expect(result.valid).toBe(true);
    });

    it('should reject empty method name', () => {
      const result = validateMethodName('');
      expect(result.valid).toBe(false);
    });

    it('should reject lowercase method name', () => {
      const result = validateMethodName('sayHello');
      expect(result.valid).toBe(false);
    });

    it('should reject method with underscores', () => {
      const result = validateMethodName('Say_Hello');
      expect(result.valid).toBe(false);
    });
  });

  describe('parseProtoFile', () => {
    it('should parse simple proto file', () => {
      const protoContent = `
syntax = "proto3";
package greet.v1;

service GreetService {
  rpc SayHello (HelloRequest) returns (HelloResponse);
}

message HelloRequest {
  string name = 1;
}

message HelloResponse {
  string message = 1;
}
`;
      const result = parseProtoFile(protoContent);
      expect(result.package).toBe('greet.v1');
      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.name).toBe('GreetService');
      expect(result.services[0]!.fullName).toBe('greet.v1.GreetService');
      expect(result.services[0]!.methods).toHaveLength(1);
      expect(result.services[0]!.methods[0]!.name).toBe('SayHello');
      expect(result.services[0]!.methods[0]!.inputType).toBe('HelloRequest');
      expect(result.services[0]!.methods[0]!.outputType).toBe('HelloResponse');
      expect(result.services[0]!.methods[0]!.clientStreaming).toBe(false);
      expect(result.services[0]!.methods[0]!.serverStreaming).toBe(false);
    });

    it('should parse streaming methods', () => {
      const protoContent = `
package stream.v1;

service StreamService {
  rpc ServerStream (Request) returns (stream Response);
  rpc ClientStream (stream Request) returns (Response);
  rpc BidiStream (stream Request) returns (stream Response);
}
`;
      const result = parseProtoFile(protoContent);
      expect(result.services[0]!.methods).toHaveLength(3);

      const serverStream = result.services[0]!.methods[0]!;
      expect(serverStream.name).toBe('ServerStream');
      expect(serverStream.clientStreaming).toBe(false);
      expect(serverStream.serverStreaming).toBe(true);

      const clientStream = result.services[0]!.methods[1]!;
      expect(clientStream.name).toBe('ClientStream');
      expect(clientStream.clientStreaming).toBe(true);
      expect(clientStream.serverStreaming).toBe(false);

      const bidiStream = result.services[0]!.methods[2]!;
      expect(bidiStream.name).toBe('BidiStream');
      expect(bidiStream.clientStreaming).toBe(true);
      expect(bidiStream.serverStreaming).toBe(true);
    });

    it('should parse message fields', () => {
      const protoContent = `
package test.v1;

message TestMessage {
  string name = 1;
  int32 age = 2;
  repeated string tags = 3;
  optional bool active = 4;
}
`;
      const result = parseProtoFile(protoContent);
      expect(result.messages['TestMessage']).toBeDefined();
      expect(result.messages['TestMessage']!.fields).toHaveLength(4);

      const nameField = result.messages['TestMessage']!.fields[0]!;
      expect(nameField.name).toBe('name');
      expect(nameField.type).toBe('string');
      expect(nameField.number).toBe(1);
      expect(nameField.repeated).toBe(false);

      const tagsField = result.messages['TestMessage']!.fields[2]!;
      expect(tagsField.repeated).toBe(true);

      const activeField = result.messages['TestMessage']!.fields[3]!;
      expect(activeField.optional).toBe(true);
    });

    it('should handle empty proto file', () => {
      const result = parseProtoFile('');
      expect(result.package).toBe('');
      expect(result.services).toHaveLength(0);
      expect(result.messages).toEqual({});
    });
  });

  describe('prepareGrpcRequest', () => {
    const mockResolveVariables = (text: string) => text.replace('{{BASE_URL}}', 'https://api.example.com');

    it('should prepare a basic request', () => {
      const request: GrpcRequest = {
        id: 'test-id',
        name: 'Test Request',
        type: 'grpc',
        methodType: 'unary',
        url: '{{BASE_URL}}',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        metadata: [],
        message: '{"name": "World"}',
        auth: { type: 'none' },
      };

      const result = prepareGrpcRequest(request, mockResolveVariables);

      expect(result.url).toBe('https://api.example.com');
      expect(result.path).toBe('/greet.v1.GreetService/SayHello');
      expect(result.metadata).toEqual({});
      expect(result.message).toEqual({ name: 'World' });
      expect(result.methodType).toBe('unary');
    });

    it('should include enabled metadata', () => {
      const request: GrpcRequest = {
        id: 'test-id',
        name: 'Test Request',
        type: 'grpc',
        methodType: 'unary',
        url: 'https://api.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        metadata: [
          { id: '1', key: 'custom-header', value: 'custom-value', enabled: true },
          { id: '2', key: 'disabled-header', value: 'disabled-value', enabled: false },
        ],
        message: '{}',
        auth: { type: 'none' },
      };

      const result = prepareGrpcRequest(request, (t) => t);

      expect(result.metadata['custom-header']).toBe('custom-value');
      expect(result.metadata['disabled-header']).toBeUndefined();
    });

    it('should merge auth metadata', () => {
      const request: GrpcRequest = {
        id: 'test-id',
        name: 'Test Request',
        type: 'grpc',
        methodType: 'unary',
        url: 'https://api.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        metadata: [{ id: '1', key: 'custom', value: 'value', enabled: true }],
        message: '{}',
        auth: { type: 'bearer', bearer: { token: 'token123' } },
      };

      const result = prepareGrpcRequest(request, (t) => t);

      expect(result.metadata['custom']).toBe('value');
      expect(result.metadata['authorization']).toBe('Bearer token123');
    });

    it('should throw error for invalid JSON message', () => {
      const request: GrpcRequest = {
        id: 'test-id',
        name: 'Test Request',
        type: 'grpc',
        methodType: 'unary',
        url: 'https://api.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        metadata: [],
        message: 'invalid json',
        auth: { type: 'none' },
      };

      expect(() => prepareGrpcRequest(request, (t) => t)).toThrow(GrpcClientError);
    });
  });

  describe('createErrorResponse', () => {
    it('should create error response from GrpcClientError', () => {
      const error = new GrpcClientError(
        'Test error',
        GrpcStatusCode.INVALID_ARGUMENT,
        'Invalid field',
        { key: 'value' }
      );
      const result = createErrorResponse('req-id', error, Date.now() - 100);

      expect(result.status).toBe(GrpcStatusCode.INVALID_ARGUMENT);
      expect(result.statusText).toBe('INVALID_ARGUMENT');
      expect(result.grpcStatus).toBe(GrpcStatusCode.INVALID_ARGUMENT);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Test error');
      expect(body.details).toBe('Invalid field');
    });

    it('should create error response from generic error', () => {
      const error = new Error('Generic error');
      const result = createErrorResponse('req-id', error, Date.now() - 100);

      expect(result.status).toBe(GrpcStatusCode.UNKNOWN);
      expect(result.grpcStatus).toBe(GrpcStatusCode.UNKNOWN);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Generic error');
    });
  });

  describe('createSuccessResponse', () => {
    it('should create unary success response', () => {
      const result = createSuccessResponse(
        'req-id',
        { message: 'Hello' },
        { 'content-type': 'application/json' },
        { 'grpc-status': '0' },
        Date.now() - 50
      );

      expect(result.status).toBe(GrpcStatusCode.OK);
      expect(result.grpcStatus).toBe(GrpcStatusCode.OK);
      expect(result.isStreaming).toBe(false);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Hello');
    });

    it('should create streaming success response', () => {
      const messages = ['{"data":1}', '{"data":2}'];
      const result = createSuccessResponse(
        'req-id',
        { complete: true },
        {},
        {},
        Date.now() - 100,
        messages
      );

      expect(result.isStreaming).toBe(true);
      expect(result.messages).toEqual(messages);
    });
  });

  describe('httpStatusToGrpcStatus', () => {
    it('should map 200 to OK', () => {
      expect(httpStatusToGrpcStatus(200)).toBe(GrpcStatusCode.OK);
    });

    it('should map 400 to INVALID_ARGUMENT', () => {
      expect(httpStatusToGrpcStatus(400)).toBe(GrpcStatusCode.INVALID_ARGUMENT);
    });

    it('should map 401 to UNAUTHENTICATED', () => {
      expect(httpStatusToGrpcStatus(401)).toBe(GrpcStatusCode.UNAUTHENTICATED);
    });

    it('should map 403 to PERMISSION_DENIED', () => {
      expect(httpStatusToGrpcStatus(403)).toBe(GrpcStatusCode.PERMISSION_DENIED);
    });

    it('should map 404 to NOT_FOUND', () => {
      expect(httpStatusToGrpcStatus(404)).toBe(GrpcStatusCode.NOT_FOUND);
    });

    it('should map 500 to INTERNAL', () => {
      expect(httpStatusToGrpcStatus(500)).toBe(GrpcStatusCode.INTERNAL);
    });

    it('should map 503 to UNAVAILABLE', () => {
      expect(httpStatusToGrpcStatus(503)).toBe(GrpcStatusCode.UNAVAILABLE);
    });

    it('should map unknown status to UNKNOWN', () => {
      expect(httpStatusToGrpcStatus(418)).toBe(GrpcStatusCode.UNKNOWN);
    });
  });

  describe('buildGrpcPath', () => {
    it('should build correct path', () => {
      const path = buildGrpcPath('greet.v1.GreetService', 'SayHello');
      expect(path).toBe('/greet.v1.GreetService/SayHello');
    });
  });

  describe('formatGrpcStatus', () => {
    it('should format OK status', () => {
      expect(formatGrpcStatus(GrpcStatusCode.OK)).toBe('0 OK');
    });

    it('should format error status', () => {
      expect(formatGrpcStatus(GrpcStatusCode.NOT_FOUND)).toBe('5 NOT_FOUND');
    });
  });

  describe('isGrpcError', () => {
    it('should return false for OK', () => {
      expect(isGrpcError(GrpcStatusCode.OK)).toBe(false);
    });

    it('should return true for error codes', () => {
      expect(isGrpcError(GrpcStatusCode.INTERNAL)).toBe(true);
      expect(isGrpcError(GrpcStatusCode.NOT_FOUND)).toBe(true);
    });
  });

  describe('getSuggestedAction', () => {
    it('should suggest action for UNAUTHENTICATED', () => {
      const action = getSuggestedAction(GrpcStatusCode.UNAUTHENTICATED);
      expect(action).toContain('authentication');
    });

    it('should suggest action for NOT_FOUND', () => {
      const action = getSuggestedAction(GrpcStatusCode.NOT_FOUND);
      expect(action).toContain('service');
    });

    it('should suggest action for UNAVAILABLE', () => {
      const action = getSuggestedAction(GrpcStatusCode.UNAVAILABLE);
      expect(action).toContain('server');
    });
  });

  describe('getMethodTypeDescription', () => {
    it('should describe unary', () => {
      const desc = getMethodTypeDescription('unary');
      expect(desc).toContain('Single request');
      expect(desc).toContain('single response');
    });

    it('should describe server-streaming', () => {
      const desc = getMethodTypeDescription('server-streaming');
      expect(desc).toContain('stream of responses');
    });

    it('should describe client-streaming', () => {
      const desc = getMethodTypeDescription('client-streaming');
      expect(desc).toContain('Stream of requests');
    });

    it('should describe bidirectional-streaming', () => {
      const desc = getMethodTypeDescription('bidirectional-streaming');
      expect(desc).toContain('Bidirectional');
    });
  });

  describe('GrpcClientError', () => {
    it('should create error with all properties', () => {
      const error = new GrpcClientError(
        'Test message',
        GrpcStatusCode.PERMISSION_DENIED,
        'Access denied',
        { user: 'test' }
      );

      expect(error.message).toBe('Test message');
      expect(error.statusCode).toBe(GrpcStatusCode.PERMISSION_DENIED);
      expect(error.details).toBe('Access denied');
      expect(error.metadata).toEqual({ user: 'test' });
      expect(error.name).toBe('GrpcClientError');
    });

    it('should create error with defaults', () => {
      const error = new GrpcClientError('Test');

      expect(error.statusCode).toBe(GrpcStatusCode.UNKNOWN);
      expect(error.details).toBe('');
      expect(error.metadata).toEqual({});
    });
  });
});
