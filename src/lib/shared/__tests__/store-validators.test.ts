import { describe, expect, it } from 'vitest';
import type { Collection, Environment, GrpcRequest, HttpRequest } from '@/types';
import {
  isValidUrl,
  validateCollection,
  validateEnvironment,
  validatePersistedSettings,
  validateRequest,
  validateRequestUpdate,
} from '../store-validators';

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

    it('persists the per-request httpVersion setting', () => {
      const request: HttpRequest = {
        id: 'req-v',
        name: 'h2c',
        type: 'http',
        method: 'GET',
        url: 'http://localhost:8090',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: {
          timeout: 30000,
          followRedirects: true,
          maxRedirects: 10,
          verifySsl: true,
          httpVersion: 'h2c-prior-knowledge',
        },
      };

      const result = validateRequest(request) as HttpRequest;
      expect(result.settings?.httpVersion).toBe('h2c-prior-knowledge');
    });

    it('accepts a partial per-request settings override (e.g. only httpVersion)', () => {
      const request: HttpRequest = {
        id: 'req-p',
        name: 'partial',
        type: 'http',
        method: 'GET',
        url: 'https://example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: { httpVersion: 'http2' },
      };
      const result = validateRequest(request) as HttpRequest;
      expect(result.settings).toEqual({ httpVersion: 'http2' });
    });

    it('rejects an unknown httpVersion literal', () => {
      const request = {
        id: 'req-v',
        name: 'bad',
        type: 'http',
        method: 'GET',
        url: 'https://example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: {
          timeout: 30000,
          followRedirects: true,
          maxRedirects: 10,
          verifySsl: true,
          httpVersion: 'http3',
        },
      };
      expect(() => validateRequest(request)).toThrow('Request validation failed');
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

    it('keeps gRPC schema snapshot provenance (hash + fetchedAt) and legacy snapshots (#937)', () => {
      const base: GrpcRequest = {
        id: 'grpc-2',
        name: 'Snap',
        type: 'grpc',
        methodType: 'unary',
        url: 'https://grpc.example.com',
        service: 'S',
        method: 'M',
        metadata: [],
        message: '{}',
        auth: { type: 'none' },
      };
      const stamped = {
        kind: 'descriptors' as const,
        descriptors: ['AA=='],
        hash: 'ab',
        fetchedAt: 7,
      };
      expect((validateRequest({ ...base, schema: stamped }) as GrpcRequest).schema).toEqual(
        stamped
      );
      const legacy = { kind: 'proto' as const, fileName: 'a.proto', text: 'x' };
      expect((validateRequest({ ...base, schema: legacy }) as GrpcRequest).schema).toEqual(legacy);
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
        method: 'NOT A TOKEN', // Spaces are not allowed in an RFC 9110 token
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      };

      expect(() => validateRequest(invalidRequest)).toThrow('Request validation failed');
    });

    it('accepts an RFC 9110 extension method (#857)', () => {
      const request = {
        id: 'req-1',
        name: 'Test Request',
        type: 'http',
        method: 'PROPFIND',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: { type: 'none' },
      };

      expect(() => validateRequest(request)).not.toThrow();
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

    it('keeps an imported GraphQL schema and GraphQL variables on the request', () => {
      const current: HttpRequest = {
        id: 'req-gql',
        name: 'GQL',
        type: 'http',
        method: 'POST',
        url: 'https://api.example.com/graphql',
        headers: [],
        params: [],
        body: { type: 'graphql', raw: '{ ping }' },
        auth: { type: 'none' },
      };
      const graphqlSchema = {
        sdl: 'type Query { ping: String }',
        source: 'sdl' as const,
        fileName: 'schema.graphql',
        importedAt: 1700000000000,
      };

      const result = validateRequestUpdate(current, {
        graphqlSchema,
        body: { type: 'graphql', raw: '{ ping }', graphqlVariables: '{"a":1}' },
      }) as HttpRequest;

      expect(result.graphqlSchema).toEqual(graphqlSchema);
      expect(result.body.graphqlVariables).toBe('{"a":1}');
    });

    it('rejects a malformed imported GraphQL schema', () => {
      const current: HttpRequest = {
        id: 'req-gql',
        name: 'GQL',
        type: 'http',
        method: 'POST',
        url: '',
        headers: [],
        params: [],
        body: { type: 'graphql', raw: '' },
        auth: { type: 'none' },
      };
      expect(() =>
        validateRequestUpdate(current, {
          graphqlSchema: { sdl: 42, source: 'sdl', importedAt: 1 } as never,
        })
      ).toThrow('Request validation failed');
    });

    it('accepts timeout 0 ("No deadline") on a gRPC streaming request', () => {
      const current: GrpcRequest = {
        id: 'grpc-stream',
        name: 'Watch',
        type: 'grpc',
        methodType: 'server-streaming',
        url: 'https://grpc.example.com',
        service: 'WatchService',
        method: 'Watch',
        metadata: [],
        message: '{}',
        auth: { type: 'none' },
        timeout: 30000,
      };
      const result = validateRequestUpdate(current, { timeout: 0 }) as GrpcRequest;
      expect(result.timeout).toBe(0);
      expect(() => validateRequestUpdate(current, { timeout: -1 })).toThrow(
        'Request validation failed'
      );
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

    it('preserves hierarchy and secret metadata when present', () => {
      const result = validateEnvironment({
        id: 'env-1',
        name: 'Staging',
        collectionId: 'collection-1',
        parentId: 'base-1',
        variables: [
          {
            id: 'var-1',
            key: 'TOKEN',
            value: 'opaque',
            enabled: true,
            description: 'API token',
            private: true,
            secretRef: { kind: 'inline', value: 'secret' },
          },
        ],
      });

      expect(result).toMatchObject({
        collectionId: 'collection-1',
        parentId: 'base-1',
        variables: [
          {
            description: 'API token',
            private: true,
            secretRef: { kind: 'inline', value: 'secret' },
          },
        ],
      });
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

    it('keeps a valid gRPC unknown-fields mode and drops an invalid one (#944)', () => {
      expect(
        (
          validatePersistedSettings({ grpcUnknownFields: 'block' }, DEFAULTS) as Record<
            string,
            unknown
          >
        ).grpcUnknownFields
      ).toBe('block');
      expect(
        'grpcUnknownFields' in validatePersistedSettings({ grpcUnknownFields: 'loud' }, DEFAULTS)
      ).toBe(false);
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
