import { describe, it, expect } from 'vitest';
import {
  validateRequest,
  validateRequestUpdate,
  validateEnvironment,
  validateCollection,
  isValidUrl,
  validatePersistedSettings,
} from '../store-validators';
import type { HttpRequest, GrpcRequest, Environment, Collection } from '@/types';

const DEFAULTS = {
  defaultTimeout: 30000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
  theme: 'dark' as const,
  layoutOrientation: 'horizontal' as const,
  accent: '#2e91ff' as const,
};

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
        variables: [{ id: 'var-1', key: 'API_URL', value: 'https://api.com', enabled: true }],
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

  describe('validatePersistedSettings', () => {
    it('returns defaults untouched for a non-object blob', () => {
      expect(validatePersistedSettings(null, DEFAULTS)).toEqual(DEFAULTS);
      expect(validatePersistedSettings('corrupt', DEFAULTS)).toEqual(DEFAULTS);
      expect(validatePersistedSettings(42, DEFAULTS)).toEqual(DEFAULTS);
    });

    it('passes a valid settings blob through and merges over defaults', () => {
      const result = validatePersistedSettings(
        { theme: 'light', maxRedirects: 3, accent: '#22c55e' },
        DEFAULTS
      );
      expect(result.theme).toBe('light');
      expect(result.maxRedirects).toBe(3);
      expect(result.accent).toBe('#22c55e');
      // Unspecified fields are backfilled from defaults.
      expect(result.followRedirects).toBe(true);
    });

    it('coerces a corrupt scalar back to a sane value (per-field .catch)', () => {
      const result = validatePersistedSettings(
        { theme: 'neon', maxRedirects: 9999, defaultTimeout: -5 },
        DEFAULTS
      );
      expect(result.theme).toBe('dark'); // invalid enum → fallback
      expect(result.maxRedirects).toBe(10); // out of [0,50] → fallback
      expect(result.defaultTimeout).toBe(30000); // below min → fallback
    });

    it('drops an invalid optional field without discarding the rest', () => {
      const result = validatePersistedSettings(
        { accent: 'not-a-hex', followRedirects: false },
        DEFAULTS
      );
      // Invalid accent is dropped → default backfills it.
      expect(result.accent).toBe('#2e91ff');
      // A sibling valid field still applies.
      expect(result.followRedirects).toBe(false);
    });

    it("backfills a corrupt required field from the CALLER's defaults, not a schema constant", () => {
      // theme 'system' here (not 'dark'): a present-but-invalid required field
      // must defer to the supplied defaults, proving the schema doesn't carry a
      // second hard-coded default that wins.
      const result = validatePersistedSettings(
        { theme: 'neon', defaultTimeout: 'oops' },
        { ...DEFAULTS, theme: 'system', defaultTimeout: 45000 }
      );
      expect(result.theme).toBe('system');
      expect(result.defaultTimeout).toBe(45000);
    });

    it('keeps unknown/future keys (passthrough)', () => {
      const result = validatePersistedSettings(
        { futureFlag: 'keep-me' } as Record<string, unknown>,
        DEFAULTS
      ) as Record<string, unknown>;
      expect(result.futureFlag).toBe('keep-me');
    });

    it('preserves a valid redirect-policy default (the half-wired field group)', () => {
      const result = validatePersistedSettings(
        { followOriginalMethod: true, disableCookieJar: true, minTlsVersion: 'TLSv1.2' },
        DEFAULTS
      ) as Record<string, unknown>;
      expect(result.followOriginalMethod).toBe(true);
      expect(result.disableCookieJar).toBe(true);
      expect(result.minTlsVersion).toBe('TLSv1.2');
    });

    it('drops the obsolete CORS-proxy preference while retaining supported settings', () => {
      const result = validatePersistedSettings(
        {
          corsProxy: { enabled: false, autoDetect: false },
          followRedirects: false,
          telemetry: { errorsEnabled: false },
        },
        DEFAULTS
      ) as Record<string, unknown>;

      expect(result).not.toHaveProperty('corsProxy');
      expect(result.followRedirects).toBe(false);
      expect(result.telemetry).toEqual({ errorsEnabled: false });
    });
  });
});
