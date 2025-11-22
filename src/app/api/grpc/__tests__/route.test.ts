import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking
import { POST } from '../route';
import { NextRequest } from 'next/server';
import { GrpcStatusCode } from '@/types';

function createRequest(body: object): NextRequest {
  return new NextRequest('http://localhost:3000/api/grpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('gRPC Proxy Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"message": "Hello"}'),
    });
  });

  describe('Successful Requests', () => {
    it('should make a successful unary gRPC call', async () => {
      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: { name: 'World' },
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.grpcStatus).toBe(GrpcStatusCode.OK);
      expect(json.grpcStatusText).toBe('OK');
      expect(json.data).toEqual({ message: 'Hello' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://grpc.example.com/greet.v1.GreetService/SayHello',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
          }),
        })
      );
    });

    it('should forward metadata as headers', async () => {
      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        metadata: {
          authorization: 'Bearer token123',
          'x-custom-header': 'custom-value',
        },
        message: { name: 'World' },
      });

      await POST(request);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer token123',
            'x-custom-header': 'custom-value',
          }),
        })
      );
    });

    it('should handle URL with trailing slash', async () => {
      const request = createRequest({
        url: 'https://grpc.example.com/',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: {},
      });

      await POST(request);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://grpc.example.com/greet.v1.GreetService/SayHello',
        expect.any(Object)
      );
    });

    it('should include response headers and trailers', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
          'x-response-header': 'value',
          'trailer-grpc-status': '0',
        }),
        text: () => Promise.resolve('{"result": "success"}'),
      });

      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'test.Service',
        method: 'Test',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.headers['x-response-header']).toBe('value');
      expect(json.trailers['grpc-status']).toBe('0');
    });
  });

  describe('Validation Errors', () => {
    it('should reject missing URL', async () => {
      const request = createRequest({
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toContain('URL');
    });

    it('should reject invalid URL format', async () => {
      const request = createRequest({
        url: 'not-a-valid-url',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toContain('URL');
    });

    it('should reject missing service name', async () => {
      const request = createRequest({
        url: 'https://grpc.example.com',
        method: 'SayHello',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toContain('service');
    });

    it('should reject invalid service name format', async () => {
      const request = createRequest({
        url: 'https://grpc.example.com',
        service: '123-invalid',
        method: 'SayHello',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toContain('service');
    });

    it('should reject missing method name', async () => {
      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'greet.v1.GreetService',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toContain('method');
    });
  });

  describe('Error Handling', () => {
    it('should handle timeout errors', async () => {
      mockFetch.mockImplementation(() => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: {},
        timeout: 1000,
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(504);
      expect(json.grpcStatus).toBe(GrpcStatusCode.DEADLINE_EXCEEDED);
      expect(json.grpcStatusText).toBe('DEADLINE_EXCEEDED');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(502);
      expect(json.grpcStatus).toBe(GrpcStatusCode.UNAVAILABLE);
    });

    it('should parse Connect error responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"code": "not_found", "message": "Service not found"}'),
      });

      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.grpcStatus).toBe(GrpcStatusCode.NOT_FOUND);
      expect(json.grpcStatusText).toBe('NOT_FOUND');
    });

    it('should handle invalid_argument error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"code": "invalid_argument", "message": "Invalid request"}'),
      });

      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.grpcStatus).toBe(GrpcStatusCode.INVALID_ARGUMENT);
    });

    it('should handle unauthenticated error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"code": "unauthenticated", "message": "Not authenticated"}'),
      });

      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(json.grpcStatus).toBe(GrpcStatusCode.UNAUTHENTICATED);
    });
  });

  describe('Response Size Limits', () => {
    it('should reject responses exceeding size limit', async () => {
      const largeResponse = 'x'.repeat(11 * 1024 * 1024); // 11MB
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(largeResponse.length) }),
        text: () => Promise.resolve(largeResponse),
      });

      const request = createRequest({
        url: 'https://grpc.example.com',
        service: 'greet.v1.GreetService',
        method: 'SayHello',
        message: {},
      });

      const response = await POST(request);
      const json = await response.json();

      expect(response.status).toBe(413);
      expect(json.error).toContain('too large');
    });
  });
});
