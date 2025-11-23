import { describe, it, expect } from 'vitest';
import {
  validateRequest,
  validateRequestUpdate,
  validateEnvironment,
  validateCollection,
  isValidUrl,
} from '../store-validators';
import { HttpRequest, GrpcRequest, Environment, Collection } from '@/types';

describe('store-validators', () => {
  describe('validateRequest', () => {
    it('should validate a valid HTTP request', () => {
      const request: HttpRequest = {
        id: 'req-1',
        name: 'Test Request',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      };

      const result = validateRequest(request);
      expect(result).toBeDefined();
      expect(result.type).toBe('http');
    });

    it('should validate a valid gRPC request', () => {
      const request: GrpcRequest = {
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

      const result = validateRequest(request);
      expect(result).toBeDefined();
      expect(result.type).toBe('grpc');
    });

    it('should throw error if validation fails', () => {
      const invalidRequest = {
        id: 'invalid',
        // missing required fields
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });

    it('should throw error for invalid HTTP method', () => {
      const invalidRequest = {
        id: 'req-1',
        name: 'Test Request',
        type: 'http',
        method: 'INVALID_METHOD', // Invalid method
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });

    it('should throw error for invalid body type', () => {
      const invalidRequest = {
        id: 'req-1',
        name: 'Test Request',
        type: 'http',
        method: 'POST',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'invalid-body-type' }, // Invalid body type
        auth: { type: 'none' },
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });

    it('should throw error for invalid auth type', () => {
      const invalidRequest = {
        id: 'req-1',
        name: 'Test Request',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'invalid-auth' }, // Invalid auth type
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });

    it('should throw error for empty name', () => {
      const invalidRequest = {
        id: 'req-1',
        name: '', // Empty name
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });

    it('should throw error for invalid gRPC method type', () => {
      const invalidRequest = {
        id: 'grpc-1',
        name: 'Test gRPC',
        type: 'grpc',
        methodType: 'invalid-stream', // Invalid method type
        url: 'https://grpc.example.com',
        service: 'UserService',
        method: 'GetUser',
        metadata: [],
        message: '{}',
        auth: { type: 'none' },
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });

    it('should validate request with api-key auth', () => {
      const request: HttpRequest = {
        id: 'req-1',
        name: 'Test Request',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: {
          type: 'api-key',
          apiKey: {
            key: 'X-API-Key',
            value: 'secret',
            in: 'header',
          },
        },
      };

      const result = validateRequest(request);
      expect(result).toBeDefined();
    });

    it('should throw error for api-key auth with invalid in value', () => {
      const invalidRequest = {
        id: 'req-1',
        name: 'Test Request',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: {
          type: 'api-key',
          apiKey: {
            key: 'X-API-Key',
            value: 'secret',
            in: 'cookie', // Invalid - only header or query allowed
          },
        },
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });
  });

  describe('validateRequestUpdate', () => {
    it('should merge and validate updates', () => {
      const current: HttpRequest = {
        id: 'req-1',
        name: 'Test',
        type: 'http',
        method: 'GET',
        url: '',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      };

      const result = validateRequestUpdate(current, {
        url: 'https://api.example.com',
        method: 'POST',
      }) as HttpRequest;

      expect(result.url).toBe('https://api.example.com');
      expect(result.method).toBe('POST');
      expect(result.name).toBe('Test');
    });
  });

  describe('validateEnvironment', () => {
    it('should validate a valid environment', () => {
      const env: Environment = {
        id: 'env-1',
        name: 'Production',
        variables: [
          { id: 'var-1', key: 'API_URL', value: 'https://api.com', enabled: true },
        ],
      };

      const result = validateEnvironment(env);
      expect(result).toBeDefined();
      expect(result.name).toBe('Production');
    });

    it('should throw error for empty environment name', () => {
      const invalidEnv = {
        id: 'env-1',
        name: '', // Empty name
        variables: [],
      };

      expect(() => validateEnvironment(invalidEnv)).toThrow('Environment validation failed');
    });

    it('should throw error for missing variables array', () => {
      const invalidEnv = {
        id: 'env-1',
        name: 'Test',
        // missing variables
      };

      expect(() => validateEnvironment(invalidEnv)).toThrow('Environment validation failed');
    });

    it('should throw error for invalid variable structure', () => {
      const invalidEnv = {
        id: 'env-1',
        name: 'Test',
        variables: [
          { key: 'TEST' }, // Missing required fields
        ],
      };

      expect(() => validateEnvironment(invalidEnv)).toThrow('Environment validation failed');
    });

    it('should validate environment with empty variables array', () => {
      const env: Environment = {
        id: 'env-1',
        name: 'Empty Env',
        variables: [],
      };

      const result = validateEnvironment(env);
      expect(result).toBeDefined();
      expect(result.variables).toHaveLength(0);
    });
  });

  describe('validateCollection', () => {
    it('should validate a valid collection', () => {
      const collection: Collection = {
        id: 'col-1',
        name: 'Test Collection',
        items: [],
      };

      const result = validateCollection(collection);
      expect(result).toBeDefined();
      expect(result.name).toBe('Test Collection');
    });

    it('should throw error for empty collection name', () => {
      const invalidCollection = {
        id: 'col-1',
        name: '', // Empty name
        items: [],
      };

      expect(() => validateCollection(invalidCollection)).toThrow('Collection validation failed');
    });

    it('should throw error for invalid item type', () => {
      const invalidCollection = {
        id: 'col-1',
        name: 'Test',
        items: [
          {
            id: 'item-1',
            name: 'Invalid Item',
            type: 'invalid-type', // Invalid type
          },
        ],
      };

      expect(() => validateCollection(invalidCollection)).toThrow('Collection validation failed');
    });

    it('should validate collection with nested folders', () => {
      const collection: Collection = {
        id: 'col-1',
        name: 'Test Collection',
        items: [
          {
            id: 'folder-1',
            name: 'API Endpoints',
            type: 'folder',
            items: [
              {
                id: 'folder-2',
                name: 'Users',
                type: 'folder',
                items: [],
              },
            ],
          },
        ],
      };

      const result = validateCollection(collection);
      expect(result).toBeDefined();
      expect(result.items).toHaveLength(1);
    });

    it('should throw error for missing items array', () => {
      const invalidCollection = {
        id: 'col-1',
        name: 'Test',
        // missing items
      };

      expect(() => validateCollection(invalidCollection)).toThrow('Collection validation failed');
    });
  });

  describe('isValidUrl', () => {
    it('should return true for valid URLs', () => {
      expect(isValidUrl('https://api.example.com')).toBe(true);
      expect(isValidUrl('http://localhost:3000')).toBe(true);
      expect(isValidUrl('https://api.example.com/users?id=1')).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      expect(isValidUrl('')).toBe(false);
      expect(isValidUrl('not-a-url')).toBe(false);
    });

    it('should allow URLs with environment variables', () => {
      expect(isValidUrl('{{baseUrl}}/users')).toBe(true);
      expect(isValidUrl('https://{{domain}}/api')).toBe(true);
    });
  });
});
