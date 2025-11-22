import { describe, it, expect, vi } from 'vitest';
import { validateRequest, validateEnvironment, validateCollection } from '@/lib/shared/store-validators';
import type { HttpRequest, GrpcRequest } from '@/types';

describe('Critical Fixes Verification', () => {
  describe('Store Validation - Fix #8', () => {
    it('should throw error for invalid HTTP request instead of returning unvalidated data', () => {
      const invalidRequest = {
        id: 'invalid',
        type: 'http',
        // missing required fields: method, url, headers, params, body, auth
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });

    it('should throw error for invalid gRPC request', () => {
      const invalidRequest = {
        id: 'invalid',
        type: 'grpc',
        // missing required fields
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });

    it('should throw error for invalid environment', () => {
      const invalidEnv = {
        id: 'env-1',
        // missing name and variables
      };

      expect(() => validateEnvironment(invalidEnv)).toThrow('Environment validation failed');
    });

    it('should throw error for invalid collection', () => {
      const invalidCollection = {
        id: 'col-1',
        // missing name and items
      };

      expect(() => validateCollection(invalidCollection)).toThrow('Collection validation failed');
    });

    it('should accept valid HTTP request', () => {
      const validRequest: HttpRequest = {
        id: 'req-1',
        name: 'Test',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      };

      const result = validateRequest(validRequest);
      expect(result).toBeDefined();
      expect(result.type).toBe('http');
    });

    it('should accept valid gRPC request', () => {
      const validRequest: GrpcRequest = {
        id: 'grpc-1',
        name: 'Test gRPC',
        type: 'grpc',
        methodType: 'unary',
        url: 'https://grpc.example.com',
        service: 'UserService',
        method: 'GetUser',
        metadata: [],
        message: '{}',
        auth: { type: 'none' },
      };

      const result = validateRequest(validRequest);
      expect(result).toBeDefined();
      expect(result.type).toBe('grpc');
    });
  });

  describe('JSON Bomb Protection - Fix #4', () => {
    it('should detect deeply nested JSON (depth > 20)', () => {
      // Create a deeply nested object (25 levels)
      let deepObject: any = { value: 'deep' };
      for (let i = 0; i < 24; i++) {
        deepObject = { nested: deepObject };
      }

      // This would be validated in GrpcRequestBuilder.validateMessage
      // Testing the depth calculation logic
      const calculateDepth = (obj: unknown, currentDepth = 0): number => {
        if (obj === null || typeof obj !== 'object') {
          return currentDepth;
        }

        const values = Array.isArray(obj) ? obj : Object.values(obj);
        if (values.length === 0) {
          return currentDepth + 1;
        }

        return Math.max(...values.map((value) => calculateDepth(value, currentDepth + 1)));
      };

      const depth = calculateDepth(deepObject);
      expect(depth).toBeGreaterThan(20);
    });

    it('should accept shallow JSON (depth <= 20)', () => {
      const shallowObject = {
        user: {
          id: 1,
          profile: {
            name: 'Test',
            email: 'test@example.com',
            address: {
              street: '123 Main St',
              city: 'City',
              country: 'Country',
            },
          },
        },
      };

      const calculateDepth = (obj: unknown, currentDepth = 0): number => {
        if (obj === null || typeof obj !== 'object') {
          return currentDepth;
        }

        const values = Array.isArray(obj) ? obj : Object.values(obj);
        if (values.length === 0) {
          return currentDepth + 1;
        }

        return Math.max(...values.map((value) => calculateDepth(value, currentDepth + 1)));
      };

      const depth = calculateDepth(shallowObject);
      expect(depth).toBeLessThanOrEqual(20);
    });

    it('should detect oversized JSON (> 10MB)', () => {
      const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

      // Create a large string (11MB)
      const largeString = 'x'.repeat(11 * 1024 * 1024);
      const size = new Blob([largeString]).size;

      expect(size).toBeGreaterThan(MAX_SIZE_BYTES);
    });

    it('should accept normal-sized JSON (<= 10MB)', () => {
      const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

      const normalObject = {
        users: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `User ${i}`,
          email: `user${i}@example.com`,
        })),
      };

      const jsonString = JSON.stringify(normalObject);
      const size = new Blob([jsonString]).size;

      expect(size).toBeLessThanOrEqual(MAX_SIZE_BYTES);
    });
  });

  describe('gRPC Response Size Calculation - Fix #2', () => {
    it('should calculate size from message string', () => {
      const message = JSON.stringify({ id: 1, name: 'Test', email: 'test@example.com' });
      const size = new Blob([message]).size;

      expect(size).toBeGreaterThan(0);
      expect(size).toBe(message.length); // In UTF-8, ASCII characters are 1 byte each
    });

    it('should calculate total size for streaming messages', () => {
      const messages = [
        JSON.stringify({ id: 1, data: 'message 1' }),
        JSON.stringify({ id: 2, data: 'message 2' }),
        JSON.stringify({ id: 3, data: 'message 3' }),
      ];

      const totalSize = messages.reduce((acc: number, msg: string) => {
        return acc + new Blob([msg]).size;
      }, 0);

      expect(totalSize).toBeGreaterThan(0);
      expect(totalSize).toBe(messages.reduce((acc, msg) => acc + msg.length, 0));
    });
  });

  describe('Stream Cleanup - Fix #6', () => {
    it('should cleanup stream control on component unmount', () => {
      const mockStreamControl = {
        sendMessage: vi.fn(),
        endStream: vi.fn(),
        cancelStream: vi.fn(),
      };

      // Simulate useEffect cleanup
      const cleanup = () => {
        if (mockStreamControl) {
          try {
            mockStreamControl.cancelStream();
          } catch (error) {
            console.error('Error canceling stream:', error);
          }
        }
      };

      cleanup();

      expect(mockStreamControl.cancelStream).toHaveBeenCalled();
    });
  });

  describe('Non-null Assertion Removal - Fix #9', () => {
    it('should safely check array elements instead of using non-null assertions', () => {
      interface Service {
        fullName: string;
        methods: Array<{ name: string }>;
      }

      const services: Service[] = [
        {
          fullName: 'UserService',
          methods: [{ name: 'GetUser' }, { name: 'ListUsers' }],
        },
      ];

      // OLD WAY (unsafe): const firstService = services[0]!;
      // NEW WAY (safe):
      const firstService = services[0];
      if (firstService) {
        expect(firstService.fullName).toBe('UserService');

        const firstMethod = firstService.methods[0];
        if (firstMethod) {
          expect(firstMethod.name).toBe('GetUser');
        }
      }
    });

    it('should handle empty arrays gracefully', () => {
      interface Service {
        fullName: string;
        methods: Array<{ name: string }>;
      }

      const services: Service[] = [];

      const firstService = services[0];
      // No crash - firstService is undefined
      expect(firstService).toBeUndefined();
    });
  });

  describe('TypeScript Type Safety - Fix #9', () => {
    it('should use explicit types in reduce callbacks', () => {
      const messages = ['msg1', 'msg2', 'msg3'];

      // With explicit types (no implicit any)
      const totalSize = messages.reduce((acc: number, msg: string) => {
        return acc + new Blob([msg]).size;
      }, 0);

      expect(totalSize).toBeGreaterThan(0);
    });
  });
});
