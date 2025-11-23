import { describe, it, expect } from 'vitest';
import { importOpenAPICollection } from '../importers';
import { OpenAPIDocument, HttpRequest } from '@/types';

// Helper function to safely cast request to HttpRequest
function asHttpRequest(request: unknown): HttpRequest {
  return request as HttpRequest;
}

describe('importOpenAPICollection', () => {
  describe('OpenAPI 3.x', () => {
    it('should import a basic OpenAPI 3.0 document', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: {
          title: 'Pet Store API',
          description: 'A sample API',
          version: '1.0.0',
        },
        servers: [{ url: 'https://api.example.com/v1' }],
        paths: {
          '/pets': {
            get: {
              summary: 'List all pets',
              operationId: 'listPets',
              responses: {
                '200': { description: 'A list of pets' },
              },
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);

      expect(collection.name).toBe('Pet Store API');
      expect(collection.description).toBe('A sample API');
      expect(collection.items).toHaveLength(1);

      const item = collection.items[0]!;
      expect(item.type).toBe('request');
      expect(item.name).toBe('List all pets');

      const request = asHttpRequest(item.request);
      expect(request.type).toBe('http');
      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://api.example.com/v1/pets');
    });

    it('should organize operations by tags into folders', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              tags: ['Users'],
              summary: 'Get users',
              responses: {},
            },
          },
          '/pets': {
            get: {
              tags: ['Pets'],
              summary: 'Get pets',
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);

      expect(collection.items).toHaveLength(2);

      const usersFolder = collection.items.find(i => i.name === 'Users');
      expect(usersFolder?.type).toBe('folder');
      expect(usersFolder?.items).toHaveLength(1);

      const petsFolder = collection.items.find(i => i.name === 'Pets');
      expect(petsFolder?.type).toBe('folder');
      expect(petsFolder?.items).toHaveLength(1);
    });

    it('should convert path parameters from {id} to {{id}} format', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/users/{userId}/posts/{postId}': {
            get: {
              summary: 'Get user post',
              parameters: [
                { name: 'userId', in: 'path', required: true },
                { name: 'postId', in: 'path', required: true },
              ],
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);
      const request = asHttpRequest(collection.items[0]!.request);

      expect(request.url).toBe('https://api.example.com/users/{{userId}}/posts/{{postId}}');
    });

    it('should extract query and header parameters', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/search': {
            get: {
              summary: 'Search',
              parameters: [
                { name: 'q', in: 'query', description: 'Search query' },
                { name: 'limit', in: 'query', schema: { default: '10' } },
                { name: 'X-Api-Key', in: 'header' },
              ],
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);
      const request = asHttpRequest(collection.items[0]!.request);

      expect(request.params).toHaveLength(2);
      expect(request.params[0]!.key).toBe('q');
      expect(request.params[0]!.description).toBe('Search query');
      expect(request.params[1]!.key).toBe('limit');
      expect(request.params[1]!.value).toBe('10');

      expect(request.headers).toHaveLength(1);
      expect(request.headers[0]!.key).toBe('X-Api-Key');
    });

    it('should convert JSON request body', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/users': {
            post: {
              summary: 'Create user',
              requestBody: {
                content: {
                  'application/json': {
                    example: { name: 'John', email: 'john@example.com' },
                  },
                },
              },
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);
      const request = asHttpRequest(collection.items[0]!.request);

      expect(request.body.type).toBe('json');
      expect(request.body.raw).toContain('"name": "John"');
    });

    it('should convert security schemes', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/secure': {
            get: {
              summary: 'Secure endpoint',
              security: [{ bearerAuth: [] }],
              responses: {},
            },
          },
        },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);
      const request = asHttpRequest(collection.items[0]!.request);

      expect(request.auth.type).toBe('bearer');
      expect(request.auth.bearer).toBeDefined();
    });

    it('should generate example from schema when no example provided', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/users': {
            post: {
              summary: 'Create user',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        age: { type: 'integer' },
                        active: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);
      const request = asHttpRequest(collection.items[0]!.request);

      expect(request.body.type).toBe('json');
      const body = JSON.parse(request.body.raw || '{}');
      expect(body).toHaveProperty('name', 'string');
      expect(body).toHaveProperty('age', 0);
      expect(body).toHaveProperty('active', false);
    });
  });

  describe('Swagger 2.0', () => {
    it('should import a Swagger 2.0 document', async () => {
      const swaggerDoc: OpenAPIDocument = {
        swagger: '2.0',
        info: {
          title: 'Swagger Pet Store',
          version: '1.0.0',
        },
        host: 'petstore.swagger.io',
        basePath: '/v2',
        schemes: ['https'],
        paths: {
          '/pet': {
            get: {
              summary: 'Get pet',
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(swaggerDoc);

      expect(collection.name).toBe('Swagger Pet Store');
      expect(collection.items).toHaveLength(1);

      const request = asHttpRequest(collection.items[0]!.request);
      expect(request.url).toBe('https://petstore.swagger.io/v2/pet');
    });

    it('should handle Swagger 2.0 body parameter', async () => {
      const swaggerDoc: OpenAPIDocument = {
        swagger: '2.0',
        info: { title: 'Test API', version: '1.0.0' },
        host: 'api.example.com',
        paths: {
          '/users': {
            post: {
              summary: 'Create user',
              parameters: [
                {
                  name: 'body',
                  in: 'body',
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                    },
                  },
                },
              ],
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(swaggerDoc);
      const request = asHttpRequest(collection.items[0]!.request);

      expect(request.body.type).toBe('json');
    });

    it('should handle Swagger 2.0 security definitions', async () => {
      const swaggerDoc: OpenAPIDocument = {
        swagger: '2.0',
        info: { title: 'Test API', version: '1.0.0' },
        host: 'api.example.com',
        paths: {
          '/secure': {
            get: {
              summary: 'Secure endpoint',
              security: [{ apiKey: [] }],
              responses: {},
            },
          },
        },
        securityDefinitions: {
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
          },
        },
      };

      const collection = await importOpenAPICollection(swaggerDoc);
      const request = asHttpRequest(collection.items[0]!.request);

      expect(request.auth.type).toBe('api-key');
      expect(request.auth.apiKey?.key).toBe('X-API-Key');
      expect(request.auth.apiKey?.in).toBe('header');
    });
  });

  describe('Edge cases', () => {
    it('should handle missing servers/host with empty base URL', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              summary: 'Get users',
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);
      const request = asHttpRequest(collection.items[0]!.request);

      expect(request.url).toBe('/users');
    });

    it('should handle operations without summary using operationId', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);

      expect(collection.items[0]!.name).toBe('getUsers');
    });

    it('should handle operations without summary or operationId', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);

      expect(collection.items[0]!.name).toBe('GET /users');
    });

    it('should handle all HTTP methods', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/resource': {
            get: { summary: 'GET', responses: {} },
            post: { summary: 'POST', responses: {} },
            put: { summary: 'PUT', responses: {} },
            delete: { summary: 'DELETE', responses: {} },
            patch: { summary: 'PATCH', responses: {} },
            options: { summary: 'OPTIONS', responses: {} },
            head: { summary: 'HEAD', responses: {} },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);

      expect(collection.items).toHaveLength(7);
      const methods = collection.items.map(i => asHttpRequest(i.request).method);
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');
      expect(methods).toContain('PUT');
      expect(methods).toContain('DELETE');
      expect(methods).toContain('PATCH');
      expect(methods).toContain('OPTIONS');
      expect(methods).toContain('HEAD');
    });

    it('should handle path-level parameters', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/users/{id}': {
            parameters: [
              { name: 'id', in: 'path', required: true },
            ],
            get: {
              summary: 'Get user',
              responses: {},
            },
            delete: {
              summary: 'Delete user',
              responses: {},
            },
          },
        },
      };

      const collection = await importOpenAPICollection(openApiDoc);

      // Both operations should have the path parameter interpolated in URL
      const getItem = collection.items.find(i => asHttpRequest(i.request).method === 'GET');
      const deleteItem = collection.items.find(i => asHttpRequest(i.request).method === 'DELETE');

      const getRequest = asHttpRequest(getItem!.request);
      const deleteRequest = asHttpRequest(deleteItem!.request);

      // Path parameters are interpolated in URL, not in params array
      expect(getRequest.url).toContain('{{id}}');
      expect(deleteRequest.url).toContain('{{id}}');
      // Params should be empty (only query params go there)
      expect(getRequest.params).toHaveLength(0);
      expect(deleteRequest.params).toHaveLength(0);
    });
  });

  describe('Error handling', () => {
    it('should throw error for non-object input', async () => {
      await expect(importOpenAPICollection('not an object')).rejects.toThrow(
        'Invalid OpenAPI document: expected an object'
      );

      await expect(importOpenAPICollection(null)).rejects.toThrow(
        'Invalid OpenAPI document: expected an object'
      );
    });

    it('should throw error for missing openapi/swagger version', async () => {
      const invalidDoc = {
        info: { title: 'Test', version: '1.0.0' },
        paths: {},
      };

      await expect(importOpenAPICollection(invalidDoc)).rejects.toThrow(
        'Invalid OpenAPI document: missing openapi or swagger version field'
      );
    });

    it('should throw error for missing info object', async () => {
      const invalidDoc = {
        openapi: '3.0.0',
        paths: {},
      };

      await expect(importOpenAPICollection(invalidDoc)).rejects.toThrow(
        'Invalid OpenAPI document: missing info object'
      );
    });

    it('should throw error for missing paths object', async () => {
      const invalidDoc = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
      };

      await expect(importOpenAPICollection(invalidDoc)).rejects.toThrow(
        'Invalid OpenAPI document: missing paths object'
      );
    });

    it('should wrap parser errors with context', async () => {
      const invalidDoc = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              responses: {
                '200': {
                  $ref: '#/components/schemas/NonExistent',
                },
              },
            },
          },
        },
      };

      await expect(importOpenAPICollection(invalidDoc)).rejects.toThrow(
        /Failed to parse OpenAPI document:/
      );
    });
  });

  describe('Circular references', () => {
    it('should handle circular $ref in schemas without infinite loop', async () => {
      const openApiDoc: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/nodes': {
            post: {
              summary: 'Create node',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/Node',
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
        components: {
          schemas: {
            Node: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                children: {
                  type: 'array',
                  items: {
                    $ref: '#/components/schemas/Node',
                  },
                },
              },
            },
          },
        },
      };

      // Should not throw or hang
      const collection = await importOpenAPICollection(openApiDoc);
      expect(collection.items).toHaveLength(1);

      const request = asHttpRequest(collection.items[0]!.request);
      expect(request.body.type).toBe('json');
      // Body should be generated without infinite loop
      expect(request.body.raw).toBeDefined();
    });
  });
});
