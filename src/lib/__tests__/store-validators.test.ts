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

    it('should return original request if validation fails', () => {
      const invalidRequest = {
        id: 'invalid',
        // missing required fields
      };

      const result = validateRequest(invalidRequest);
      expect(result).toEqual(invalidRequest);
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
