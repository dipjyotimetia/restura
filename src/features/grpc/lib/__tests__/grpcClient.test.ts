import { describe, expect, it, vi } from 'vitest';
import type { AuthConfig, GrpcRequest } from '@/types';
import { GrpcStatusCode } from '@/types';
import {
  buildAuthMetadata,
  buildGrpcPath,
  createErrorResponse,
  createSuccessResponse,
  describeGrpcAuthMetadata,
  formatGrpcStatus,
  GrpcClientError,
  getMethodTypeDescription,
  getSuggestedAction,
  grpcAuthNeedsMainSideApply,
  grpcUnsupportedAuthMessage,
  httpStatusToGrpcStatus,
  isGrpcError,
  MAX_GRPC_METADATA_BYTES,
  makeElectronGrpcRequest,
  makeProxyGrpcRequest,
  parseProtoFile,
  prepareGrpcRequest,
  validateGrpcUrl,
  validateMethodName,
  validateServiceName,
} from '../grpcClient';

const UNSUPPORTED_AUTHS: AuthConfig[] = [
  { type: 'digest', digest: { username: 'user', password: 'pass' } },
  {
    type: 'aws-signature',
    awsSignature: {
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'execute-api',
    },
  },
  { type: 'oauth1', oauth1: { consumerKey: 'ck', consumerSecret: 'cs' } } as AuthConfig,
  { type: 'ntlm', ntlm: { username: 'u', password: 'p' } } as AuthConfig,
  { type: 'wsse', wsse: { username: 'u', password: 'p' } } as AuthConfig,
];

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

    it.each(UNSUPPORTED_AUTHS)('returns no metadata for $type without logging', (auth) => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(buildAuthMetadata(auth)).toEqual({});
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // #900: sign-at-wire / challenge auth has no gRPC binding yet. Sending would
  // silently go out unauthenticated, so the call is blocked with a clear error.
  describe('unsupported gRPC auth types (#900)', () => {
    const baseReq: GrpcRequest = {
      id: 'req-auth',
      name: 'Test',
      type: 'grpc',
      methodType: 'unary',
      url: 'https://api.example.com',
      service: 'svc.v1.Service',
      method: 'Call',
      metadata: [],
      message: '{}',
      auth: { type: 'none' },
    };

    it.each(UNSUPPORTED_AUTHS)('reports $type as unsupported', (auth) => {
      const message = grpcUnsupportedAuthMessage(auth);
      expect(message).toMatch(/not supported for gRPC/);
      expect(message).toMatch(/without credentials/i);
    });

    it.each<AuthConfig>([
      { type: 'none' },
      { type: 'bearer', bearer: { token: 't' } },
      { type: 'basic', basic: { username: 'u', password: 'p' } },
      { type: 'api-key', apiKey: { key: 'x-api-key', value: 'v', in: 'header' } },
      { type: 'oauth2', oauth2: { accessToken: 'a' } },
    ])('does not flag $type', (auth) => {
      expect(grpcUnsupportedAuthMessage(auth)).toBeNull();
    });

    it.each(UNSUPPORTED_AUTHS)('auth preview explains $type is not sent', (auth) => {
      expect(describeGrpcAuthMetadata(auth)).toBe(grpcUnsupportedAuthMessage(auth));
    });

    it('auth preview masks supported credentials', () => {
      expect(
        describeGrpcAuthMetadata({ type: 'bearer', bearer: { token: 'secret-token-value' } })
      ).toBe('authorization: Bearer sec...');
      expect(describeGrpcAuthMetadata({ type: 'none' })).toBe('No authentication configured');
    });

    it.each(UNSUPPORTED_AUTHS)('prepareGrpcRequest blocks the send for $type', (auth) => {
      let caught: unknown;
      try {
        prepareGrpcRequest({ ...baseReq, auth }, (s) => s);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GrpcClientError);
      expect((caught as GrpcClientError).statusCode).toBe(GrpcStatusCode.FAILED_PRECONDITION);
      expect((caught as GrpcClientError).message).toBe(grpcUnsupportedAuthMessage(auth));
    });

    it.each(UNSUPPORTED_AUTHS)('web proxy never sends a $type request', async (auth) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(makeProxyGrpcRequest({ ...baseReq, auth }, (s) => s)).rejects.toThrow(
        /not supported for gRPC/
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
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

    it('should strip block comments before parsing', () => {
      const protoContent = `
/* file-level comment */
package comments.v1;

/*
 * Multi-line block comment
 */
service CommentService {
  /* inline */ rpc GetData (DataRequest) returns (DataResponse);
}

message DataRequest {
  /* comment */ string id = 1;
  int32 count = 2;
}
`;
      const result = parseProtoFile(protoContent);
      expect(result.package).toBe('comments.v1');
      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.name).toBe('CommentService');
      expect(result.services[0]!.methods).toHaveLength(1);
      expect(result.services[0]!.methods[0]!.name).toBe('GetData');
      expect(result.messages['DataRequest']).toBeDefined();
      expect(result.messages['DataRequest']!.fields).toHaveLength(2);
      expect(result.messages['DataRequest']!.fields[0]!.name).toBe('id');
      expect(result.messages['DataRequest']!.fields[1]!.name).toBe('count');
    });

    it('should parse rpc definitions that span multiple lines', () => {
      const protoContent = `
package multiline.v1;

service MultilineService {
  rpc UnaryCall (
    UnaryRequest
  ) returns (
    UnaryResponse
  );
  rpc StreamCall (stream
    StreamRequest) returns (stream
    StreamResponse);
}
`;
      const result = parseProtoFile(protoContent);
      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.methods).toHaveLength(2);
      const unary = result.services[0]!.methods[0]!;
      expect(unary.name).toBe('UnaryCall');
      expect(unary.inputType).toBe('UnaryRequest');
      expect(unary.outputType).toBe('UnaryResponse');
      expect(unary.clientStreaming).toBe(false);
      expect(unary.serverStreaming).toBe(false);
      const streaming = result.services[0]!.methods[1]!;
      expect(streaming.name).toBe('StreamCall');
      expect(streaming.clientStreaming).toBe(true);
      expect(streaming.serverStreaming).toBe(true);
    });

    it('should parse service and message with opening brace on next line', () => {
      const protoContent = `
package nextline.v1;

service NextLineService
{
  rpc Ping (PingRequest) returns (PingResponse);
}

message PingRequest
{
  string payload = 1;
}
`;
      const result = parseProtoFile(protoContent);
      expect(result.package).toBe('nextline.v1');
      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.name).toBe('NextLineService');
      expect(result.services[0]!.methods[0]!.name).toBe('Ping');
      expect(result.messages['PingRequest']).toBeDefined();
      expect(result.messages['PingRequest']!.fields[0]!.name).toBe('payload');
    });
  });

  describe('prepareGrpcRequest', () => {
    const mockResolveVariables = (text: string) =>
      text.replace('{{BASE_URL}}', 'https://api.example.com');

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
      expect(result.metadata).toEqual({ traceparent: expect.any(String) });
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

    it('covers all remaining status code branches', () => {
      expect(getSuggestedAction(GrpcStatusCode.PERMISSION_DENIED)).toContain('permissions');
      expect(getSuggestedAction(GrpcStatusCode.INVALID_ARGUMENT)).toContain('message format');
      expect(getSuggestedAction(GrpcStatusCode.DEADLINE_EXCEEDED)).toContain('timeout');
      expect(getSuggestedAction(GrpcStatusCode.UNIMPLEMENTED)).toContain('supported');
      expect(getSuggestedAction(GrpcStatusCode.INTERNAL)).toContain('internal error');
      expect(getSuggestedAction(GrpcStatusCode.RESOURCE_EXHAUSTED)).toContain('Rate limit');
      expect(getSuggestedAction(GrpcStatusCode.CANCELLED)).toContain('error details');
    });
  });

  describe('getMethodTypeDescription default branch', () => {
    it('returns unknown for unknown method type', () => {
      expect(getMethodTypeDescription('unknown-type')).toContain('Unknown');
    });
  });

  describe('prepareGrpcRequest metadata size validation', () => {
    const baseGrpcReq: GrpcRequest = {
      id: 'req-meta',
      name: 'Test',
      type: 'grpc',
      methodType: 'unary',
      url: 'https://api.example.com',
      service: 'svc.v1.Service',
      method: 'Call',
      metadata: [],
      message: '{}',
      auth: { type: 'none' },
    };

    // #895: ordinary bearer JWTs (Azure AD, Auth0, GCP ID tokens) are 1.2–2 KB.
    it('accepts a 2 KB bearer token (no per-header cap)', () => {
      const token = 'eyJ'.padEnd(2048, 'a');
      const req: GrpcRequest = {
        ...baseGrpcReq,
        auth: { type: 'bearer', bearer: { token } },
      };
      const result = prepareGrpcRequest(req, (s) => s);
      expect(result.metadata.authorization).toBe(`Bearer ${token}`);
    });

    it('accepts a single large user metadata value under the aggregate cap', () => {
      const req: GrpcRequest = {
        ...baseGrpcReq,
        metadata: [{ id: '1', key: 'x-big', value: 'x'.repeat(4096), enabled: true }],
      };
      expect(prepareGrpcRequest(req, (s) => s).metadata['x-big']).toHaveLength(4096);
    });

    it('throws a clear error when total metadata exceeds the aggregate cap', () => {
      const entries = Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        key: `x-key-${i}`,
        value: 'x'.repeat(1024),
        enabled: true,
      }));
      const req: GrpcRequest = { ...baseGrpcReq, metadata: entries };
      expect(() => prepareGrpcRequest(req, (s) => s)).toThrow(
        new RegExp(`exceeds maximum of ${MAX_GRPC_METADATA_BYTES} bytes`)
      );
      try {
        prepareGrpcRequest(req, (s) => s);
      } catch (err) {
        expect(err).toBeInstanceOf(GrpcClientError);
        expect((err as GrpcClientError).statusCode).toBe(GrpcStatusCode.INVALID_ARGUMENT);
      }
    });

    it('measures the aggregate cap in UTF-8 bytes, not UTF-16 code units', () => {
      // 6000 × '€' = 6000 UTF-16 units but 18000 UTF-8 bytes.
      const req: GrpcRequest = {
        ...baseGrpcReq,
        metadata: [{ id: '1', key: 'x-euro', value: '€'.repeat(6000), enabled: true }],
      };
      expect(() => prepareGrpcRequest(req, (s) => s)).toThrow(GrpcClientError);
    });

    it('caps total metadata at 16 KiB', () => {
      expect(MAX_GRPC_METADATA_BYTES).toBe(16 * 1024);
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

  describe('makeElectronGrpcRequest (Electron mocked)', () => {
    const grpcReq: GrpcRequest = {
      id: 'req-el-1',
      name: 'Test',
      type: 'grpc',
      methodType: 'unary',
      url: 'https://api.example.com',
      service: 'pkg.TestService',
      method: 'GetItem',
      metadata: [],
      message: '{"id": 1}',
      auth: { type: 'none' },
    };

    it('makes request and returns response in Electron mode', async () => {
      const mockGrpcResponse = {
        status: 0,
        statusText: 'OK',
        headers: {},
        trailers: {},
        message: { result: 'ok' },
        messages: undefined,
        size: 50,
      };

      const mockElectron = {
        isElectron: true,
        grpc: {
          request: vi.fn().mockResolvedValue(mockGrpcResponse),
          reflect: vi.fn(),
          startStream: vi.fn(),
          sendMessage: vi.fn(),
          endStream: vi.fn(),
          cancelStream: vi.fn(),
          on: vi.fn(),
          removeListener: vi.fn(),
        },
      };

      Object.defineProperty(window, 'electron', {
        value: mockElectron,
        writable: true,
        configurable: true,
      });

      try {
        const result = await makeElectronGrpcRequest(
          grpcReq,
          'syntax = "proto3";',
          'test.proto',
          (s) => s
        );
        expect(result.status).toBe(0);
        expect(result.grpcStatus).toBe(0);
        expect(mockElectron.grpc.request).toHaveBeenCalledOnce();
      } finally {
        Object.defineProperty(window, 'electron', {
          value: undefined,
          writable: true,
          configurable: true,
        });
      }
    });

    it('handles streaming messages array in response', async () => {
      const mockGrpcResponseWithMessages = {
        status: 0,
        statusText: 'OK',
        headers: {},
        trailers: {},
        message: undefined,
        messages: [{ item: 1 }, { item: 2 }],
        size: 200,
      };

      const mockElectron2 = {
        isElectron: true,
        grpc: {
          request: vi.fn().mockResolvedValue(mockGrpcResponseWithMessages),
          reflect: vi.fn(),
          startStream: vi.fn(),
          sendMessage: vi.fn(),
          endStream: vi.fn(),
          cancelStream: vi.fn(),
          on: vi.fn(),
          removeListener: vi.fn(),
        },
      };

      Object.defineProperty(window, 'electron', {
        value: mockElectron2,
        writable: true,
        configurable: true,
      });

      try {
        const result = await makeElectronGrpcRequest(
          grpcReq,
          'syntax = "proto3";',
          'test.proto',
          (s) => s
        );
        expect(result.isStreaming).toBe(true);
        expect(result.messages).toHaveLength(2);
      } finally {
        Object.defineProperty(window, 'electron', {
          value: undefined,
          writable: true,
          configurable: true,
        });
      }
    });

    it('returns error response when Electron API throws', async () => {
      const mockElectron = {
        isElectron: true,
        grpc: {
          request: vi.fn().mockRejectedValue(new Error('IPC error')),
          reflect: vi.fn(),
          startStream: vi.fn(),
          sendMessage: vi.fn(),
          endStream: vi.fn(),
          cancelStream: vi.fn(),
          on: vi.fn(),
          removeListener: vi.fn(),
        },
      };

      Object.defineProperty(window, 'electron', {
        value: mockElectron,
        writable: true,
        configurable: true,
      });

      try {
        const result = await makeElectronGrpcRequest(
          grpcReq,
          'syntax = "proto3";',
          'test.proto',
          (s) => s
        );
        expect(result.status).toBeGreaterThanOrEqual(0);
      } finally {
        Object.defineProperty(window, 'electron', {
          value: undefined,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  describe('makeElectronGrpcRequest (non-Electron)', () => {
    it('should throw when not in Electron environment', async () => {
      const request: GrpcRequest = {
        id: 'req-1',
        name: 'Test',
        type: 'grpc',
        methodType: 'unary',
        url: 'https://api.example.com',
        service: 'pkg.TestService',
        method: 'GetItem',
        metadata: [],
        message: '{}',
        auth: { type: 'none' },
      };

      await expect(makeElectronGrpcRequest(request, '', 'test.proto', (t) => t)).rejects.toThrow(
        'Electron environment required'
      );
    });
  });

  // gRPC streaming is now driven by startGrpcStream() — covered in
  // grpcStreamingClient.test.ts (web connect-fetch + the Electron IPC handle).

  describe('makeProxyGrpcRequest', () => {
    it('makes proxy gRPC request and returns response', async () => {
      const mockResponse = {
        grpcStatus: 0,
        grpcStatusText: 'OK',
        data: { id: 1 },
        headers: { 'content-type': 'application/grpc' },
        size: 100,
        trailers: {},
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify(mockResponse), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
        )
      );

      const { makeProxyGrpcRequest } = await import('../grpcClient');

      const grpcReq = {
        id: 'req-proxy-1',
        name: 'Test',
        type: 'grpc' as const,
        methodType: 'unary' as const,
        url: 'https://grpc.example.com',
        service: 'svc.TestService',
        method: 'GetUser',
        metadata: [],
        message: '{"id": 1}',
        auth: { type: 'none' as const },
      };

      const result = await makeProxyGrpcRequest(grpcReq, (s) => s);
      expect(result.status).toBe(0);
      expect(result.grpcStatus).toBe(0);
    });

    it('returns error response when fetch throws', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('Network error');
        })
      );

      const { makeProxyGrpcRequest } = await import('../grpcClient');

      const grpcReq = {
        id: 'req-proxy-2',
        name: 'Test',
        type: 'grpc' as const,
        methodType: 'unary' as const,
        url: 'https://grpc.example.com',
        service: 'svc.TestService',
        method: 'GetUser',
        metadata: [],
        message: '{"id": 1}',
        auth: { type: 'none' as const },
      };

      const result = await makeProxyGrpcRequest(grpcReq, (s) => s);
      expect(result.status).toBeGreaterThanOrEqual(0);
    });
  });

  describe('SecretRef handle auth (ADR-0007)', () => {
    const handleAuth: AuthConfig = {
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h-grpc-1' } },
    };
    const inlineAuth: AuthConfig = {
      type: 'bearer',
      bearer: { token: { kind: 'inline', value: 'tok-123' } },
    };

    it('grpcAuthNeedsMainSideApply is true for a handle, false for inline/none', () => {
      expect(grpcAuthNeedsMainSideApply(handleAuth)).toBe(true);
      expect(grpcAuthNeedsMainSideApply(inlineAuth)).toBe(false);
      expect(grpcAuthNeedsMainSideApply({ type: 'none' })).toBe(false);
    });

    it('buildAuthMetadata drops the handle (renderer cannot read plaintext)', () => {
      expect(buildAuthMetadata(handleAuth)).toEqual({});
      // Inline is applied in-renderer as usual.
      expect(buildAuthMetadata(inlineAuth)).toEqual({ authorization: 'Bearer tok-123' });
    });

    it('makeElectronGrpcRequest threads the auth descriptor through IPC for a handle', async () => {
      const requestMock = vi.fn().mockResolvedValue({
        status: 0,
        statusText: 'OK',
        headers: {},
        trailers: {},
        message: {},
        size: 0,
      });
      Object.defineProperty(window, 'electron', {
        value: { isElectron: true, grpc: { request: requestMock } },
        writable: true,
        configurable: true,
      });
      try {
        const req: GrpcRequest = {
          id: 'req-handle-1',
          name: 'T',
          type: 'grpc',
          methodType: 'unary',
          url: 'https://api.example.com',
          service: 'pkg.Svc',
          method: 'Get',
          metadata: [],
          message: '{}',
          auth: handleAuth,
        };
        await makeElectronGrpcRequest(req, 'syntax = "proto3";', 'test.proto', (s) => s);
        const payload = requestMock.mock.calls[0]![0] as {
          auth?: AuthConfig;
          metadata: Record<string, string>;
        };
        expect(payload.auth).toEqual(handleAuth);
        // The handle is NOT pre-applied into metadata on the renderer side.
        expect(payload.metadata['authorization']).toBeUndefined();
      } finally {
        Object.defineProperty(window, 'electron', {
          value: undefined,
          writable: true,
          configurable: true,
        });
      }
    });

    it('makeElectronGrpcRequest omits the auth descriptor for inline creds', async () => {
      const requestMock = vi.fn().mockResolvedValue({
        status: 0,
        statusText: 'OK',
        headers: {},
        trailers: {},
        message: {},
        size: 0,
      });
      Object.defineProperty(window, 'electron', {
        value: { isElectron: true, grpc: { request: requestMock } },
        writable: true,
        configurable: true,
      });
      try {
        const req: GrpcRequest = {
          id: 'req-inline-1',
          name: 'T',
          type: 'grpc',
          methodType: 'unary',
          url: 'https://api.example.com',
          service: 'pkg.Svc',
          method: 'Get',
          metadata: [],
          message: '{}',
          auth: inlineAuth,
        };
        await makeElectronGrpcRequest(req, 'syntax = "proto3";', 'test.proto', (s) => s);
        const payload = requestMock.mock.calls[0]![0] as {
          auth?: AuthConfig;
          metadata: Record<string, string>;
        };
        expect(payload.auth).toBeUndefined();
        expect(payload.metadata['authorization']).toBe('Bearer tok-123');
      } finally {
        Object.defineProperty(window, 'electron', {
          value: undefined,
          writable: true,
          configurable: true,
        });
      }
    });

    it('makeProxyGrpcRequest (web) rejects a handle with UNAUTHENTICATED instead of sending it', async () => {
      const req: GrpcRequest = {
        id: 'req-web-handle',
        name: 'T',
        type: 'grpc',
        methodType: 'unary',
        url: 'https://api.example.com',
        service: 'pkg.Svc',
        method: 'Get',
        metadata: [],
        message: '{}',
        auth: handleAuth,
      };
      // A synthesized UNAUTHENTICATED GrpcClientError is produced only by the
      // pre-fetch guard; the network path derives its status from the upstream
      // response. So this result proves no request was sent.
      const result = await makeProxyGrpcRequest(req, (s) => s);
      expect(result.grpcStatus).toBe(GrpcStatusCode.UNAUTHENTICATED);
    });
  });
});
