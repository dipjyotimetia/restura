import { Collection, CollectionItem, PostmanCollection, PostmanItem, PostmanAuth, InsomniaCollection, HttpRequest, KeyValue, AuthConfig, OpenAPIDocument, OpenAPIOperation, OpenAPIParameter, OpenAPISecurityScheme, OpenAPISchema, HttpMethod } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import SwaggerParser from '@apidevtools/swagger-parser';

// Postman Collection Importer
export function importPostmanCollection(postmanData: PostmanCollection): Collection {
  const collection: Collection = {
    id: uuidv4(),
    name: postmanData.info.name,
    description: postmanData.info.description,
    items: [],
    auth: postmanData.auth ? convertPostmanAuth(postmanData.auth) : undefined,
  };

  collection.items = postmanData.item.map((item) => convertPostmanItem(item, collection.auth));

  return collection;
}

function convertPostmanItem(item: PostmanItem, parentAuth?: AuthConfig): CollectionItem {
  // If it's a folder
  if (item.item && Array.isArray(item.item)) {
    return {
      id: uuidv4(),
      name: item.name,
      type: 'folder',
      items: item.item.map((subItem) => convertPostmanItem(subItem, parentAuth)),
    };
  }

  // If it's a request
  const request: HttpRequest = {
    id: uuidv4(),
    name: item.name,
    type: 'http',
    method: (item.request?.method as HttpRequest['method']) || 'GET',
    url: typeof item.request?.url === 'string' ? item.request.url : item.request?.url?.raw || '',
    headers: convertPostmanHeaders(item.request?.header || []),
    params: convertPostmanParams(item.request?.url),
    body: convertPostmanBody(item.request?.body),
    auth: item.request?.auth ? convertPostmanAuth(item.request.auth) : (parentAuth || { type: 'none' }),
    preRequestScript: item.event?.find((e) => e.listen === 'prerequest')?.script?.exec?.join('\n'),
    testScript: item.event?.find((e) => e.listen === 'test')?.script?.exec?.join('\n'),
  };

  return {
    id: uuidv4(),
    name: item.name,
    type: 'request',
    request,
  };
}

function convertPostmanHeaders(headers: Array<{ key: string; value: string; disabled?: boolean; description?: string }>): KeyValue[] {
  return headers.map((header) => ({
    id: uuidv4(),
    key: header.key,
    value: header.value,
    enabled: !header.disabled,
    description: header.description,
  }));
}

function convertPostmanParams(url: unknown): KeyValue[] {
  if (!url || typeof url !== 'object' || !('query' in url) || !Array.isArray(url.query)) return [];

  return url.query.map((param: { key: string; value: string; disabled?: boolean; description?: string }) => ({
    id: uuidv4(),
    key: param.key,
    value: param.value,
    enabled: !param.disabled,
    description: param.description,
  }));
}

function convertPostmanBody(body: { mode?: string; raw?: string; urlencoded?: Array<{ key: string; value: string }> } | undefined): HttpRequest['body'] {
  if (!body) return { type: 'none' };

  const modeMap: Record<string, HttpRequest['body']['type']> = {
    'raw': 'json',
    'formdata': 'form-data',
    'urlencoded': 'x-www-form-urlencoded',
    'file': 'binary',
  };

  return {
    type: (body.mode && modeMap[body.mode]) || 'none',
    raw: body.raw || body.urlencoded?.map((item) => `${item.key}=${item.value}`).join('&'),
  };
}

function convertPostmanAuth(auth: PostmanAuth): AuthConfig {
  const type = auth.type;

  type AuthItem = { key: string; value: string; type?: string };

  const getAuthValue = (items: unknown, key: string): string => {
    if (!Array.isArray(items)) return '';
    const item = items.find((i: AuthItem) => i.key === key);
    return item?.value || '';
  };

  switch (type) {
    case 'basic':
      return {
        type: 'basic',
        basic: {
          username: getAuthValue(auth.basic, 'username'),
          password: getAuthValue(auth.basic, 'password'),
        },
      };
    case 'bearer':
      return {
        type: 'bearer',
        bearer: {
          token: getAuthValue(auth.bearer, 'token'),
        },
      };
    case 'apikey':
      return {
        type: 'api-key',
        apiKey: {
          key: getAuthValue(auth.apikey, 'key'),
          value: getAuthValue(auth.apikey, 'value'),
          in: getAuthValue(auth.apikey, 'in') === 'query' ? 'query' : 'header',
        },
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: getAuthValue(auth.oauth2, 'accessToken'),
        },
      };
    case 'awsv4':
      return {
        type: 'aws-signature',
        awsSignature: {
          accessKey: getAuthValue(auth.awsv4, 'accessKey'),
          secretKey: getAuthValue(auth.awsv4, 'secretKey'),
          region: getAuthValue(auth.awsv4, 'region'),
          service: getAuthValue(auth.awsv4, 'service'),
        },
      };
    default:
      return { type: 'none' };
  }
}

// Insomnia Collection Importer
export function importInsomniaCollection(insomniaData: InsomniaCollection): Collection {
  const workspaces = insomniaData.resources.filter((r) => r._type === 'workspace');
  const requests = insomniaData.resources.filter((r) => r._type === 'request');
  const folders = insomniaData.resources.filter((r) => r._type === 'request_group');

  const workspace = workspaces[0];

  const collection: Collection = {
    id: uuidv4(),
    name: workspace?.name || 'Imported Collection',
    items: [],
  };

  // Build folder structure
  const folderMap = new Map<string, CollectionItem>();

  folders.forEach((folder) => {
    const item: CollectionItem = {
      id: folder._id,
      name: folder.name || 'Unnamed Folder',
      type: 'folder',
      items: [],
    };
    folderMap.set(folder._id, item);
  });

  // Add requests to folders or root
  requests.forEach((req) => {
    const request: HttpRequest = {
      id: uuidv4(),
      name: req.name || 'Unnamed Request',
      type: 'http',
      method: (req.method as HttpRequest['method']) || 'GET',
      url: req.url || '',
      headers: convertInsomniaHeaders(req.headers || []),
      params: convertInsomniaParams(req.parameters || []),
      body: convertInsomniaBody(req.body),
      auth: convertInsomniaAuth(req.authentication),
    };

    const item: CollectionItem = {
      id: req._id,
      name: req.name || 'Unnamed Request',
      type: 'request',
      request,
    };

    if (req.parentId && folderMap.has(req.parentId)) {
      folderMap.get(req.parentId)!.items!.push(item);
    } else {
      collection.items.push(item);
    }
  });

  // Add folders to collection
  folders.forEach((folder) => {
    if (!folder.parentId || (workspace && folder.parentId === workspace._id)) {
      const item = folderMap.get(folder._id);
      if (item) {
        collection.items.push(item);
      }
    }
  });

  return collection;
}

function convertInsomniaHeaders(headers: Array<{ name: string; value: string; disabled?: boolean }>): KeyValue[] {
  if (!headers) return [];
  return headers.map((header) => ({
    id: uuidv4(),
    key: header.name,
    value: header.value,
    enabled: !header.disabled,
  }));
}

function convertInsomniaParams(params: Array<{ name: string; value: string; disabled?: boolean }>): KeyValue[] {
  if (!params) return [];
  return params.map((param) => ({
    id: uuidv4(),
    key: param.name,
    value: param.value,
    enabled: !param.disabled,
  }));
}

function convertInsomniaBody(body: { mimeType?: string; text?: string } | undefined): HttpRequest['body'] {
  if (!body) return { type: 'none' };

  const mimeTypeMap: Record<string, HttpRequest['body']['type']> = {
    'application/json': 'json',
    'application/xml': 'xml',
    'text/plain': 'text',
    'application/x-www-form-urlencoded': 'x-www-form-urlencoded',
    'multipart/form-data': 'form-data',
  };

  return {
    type: (body.mimeType && mimeTypeMap[body.mimeType]) || 'text',
    raw: body.text,
  };
}

function convertInsomniaAuth(auth: { type?: string; username?: string; password?: string; token?: string; key?: string; value?: string; addTo?: string; accessToken?: string } | undefined): AuthConfig {
  if (!auth) return { type: 'none' };

  switch (auth.type) {
    case 'basic':
      return {
        type: 'basic',
        basic: {
          username: auth.username || '',
          password: auth.password || '',
        },
      };
    case 'bearer':
      return {
        type: 'bearer',
        bearer: {
          token: auth.token || '',
        },
      };
    case 'apikey':
      return {
        type: 'api-key',
        apiKey: {
          key: auth.key || '',
          value: auth.value || '',
          in: auth.addTo === 'queryParams' ? 'query' : 'header',
        },
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: auth.accessToken || '',
        },
      };
    default:
      return { type: 'none' };
  }
}

// OpenAPI/Swagger Collection Importer
export async function importOpenAPICollection(openApiData: unknown): Promise<Collection> {
  // Validate basic structure before processing
  if (!openApiData || typeof openApiData !== 'object') {
    throw new Error('Invalid OpenAPI document: expected an object');
  }

  const doc = openApiData as Record<string, unknown>;
  if (!doc.openapi && !doc.swagger) {
    throw new Error('Invalid OpenAPI document: missing openapi or swagger version field');
  }

  if (!doc.info || typeof doc.info !== 'object') {
    throw new Error('Invalid OpenAPI document: missing info object');
  }

  if (!doc.paths || typeof doc.paths !== 'object') {
    throw new Error('Invalid OpenAPI document: missing paths object');
  }

  // Validate and dereference the spec (resolves all $refs)
  // Disable external resolution for security
  let api: OpenAPIDocument;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api = await SwaggerParser.dereference(openApiData as any, {
      resolve: { external: false },
    }) as unknown as OpenAPIDocument;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parsing error';
    throw new Error(`Failed to parse OpenAPI document: ${message}`);
  }

  const isSwagger2 = 'swagger' in api && api.swagger;

  // Determine base URL
  const baseUrl = isSwagger2
    ? `${api.schemes?.[0] || 'https'}://${api.host || 'localhost'}${api.basePath || ''}`
    : api.servers?.[0]?.url || '';

  // Get security schemes
  const securitySchemes = isSwagger2
    ? api.securityDefinitions
    : api.components?.securitySchemes;

  const collection: Collection = {
    id: uuidv4(),
    name: api.info.title,
    description: api.info.description,
    items: [],
  };

  // Group operations by tags
  const taggedOperations = new Map<string, CollectionItem[]>();
  const untaggedOperations: CollectionItem[] = [];

  // Process each path
  for (const [path, pathItem] of Object.entries(api.paths)) {
    const methods: Array<[string, OpenAPIOperation | undefined]> = [
      ['GET', pathItem.get],
      ['POST', pathItem.post],
      ['PUT', pathItem.put],
      ['DELETE', pathItem.delete],
      ['PATCH', pathItem.patch],
      ['OPTIONS', pathItem.options],
      ['HEAD', pathItem.head],
    ];

    for (const [method, operation] of methods) {
      if (!operation) continue;

      // Merge path-level and operation-level parameters
      const allParams = [...(pathItem.parameters || []), ...(operation.parameters || [])];

      const request = convertOpenAPIOperation(
        path,
        method as HttpMethod,
        operation,
        allParams,
        baseUrl,
        securitySchemes,
        isSwagger2 ? api.definitions : api.components?.schemas
      );

      const item: CollectionItem = {
        id: uuidv4(),
        name: operation.summary || operation.operationId || `${method} ${path}`,
        type: 'request',
        request,
      };

      // Group by first tag or put in untagged
      const tag = operation.tags?.[0];
      if (tag) {
        if (!taggedOperations.has(tag)) {
          taggedOperations.set(tag, []);
        }
        taggedOperations.get(tag)!.push(item);
      } else {
        untaggedOperations.push(item);
      }
    }
  }

  // Create folders for tags
  for (const [tagName, items] of taggedOperations) {
    collection.items.push({
      id: uuidv4(),
      name: tagName,
      type: 'folder',
      items,
    });
  }

  // Add untagged operations to root
  collection.items.push(...untaggedOperations);

  return collection;
}

function convertOpenAPIOperation(
  path: string,
  method: HttpMethod,
  operation: OpenAPIOperation,
  parameters: OpenAPIParameter[],
  baseUrl: string,
  securitySchemes?: Record<string, OpenAPISecurityScheme>,
  schemas?: Record<string, OpenAPISchema>
): HttpRequest {
  // Convert path parameters from {id} to {{id}} format
  const convertedPath = path.replace(/\{([^}]+)\}/g, '{{$1}}');
  const url = `${baseUrl}${convertedPath}`;

  // Separate parameters by type
  const queryParams = parameters.filter(p => p.in === 'query');
  const headerParams = parameters.filter(p => p.in === 'header');
  const pathParams = parameters.filter(p => p.in === 'path');

  return {
    id: uuidv4(),
    name: operation.summary || operation.operationId || `${method} ${path}`,
    type: 'http',
    method,
    url,
    headers: convertOpenAPIHeaders(headerParams),
    params: convertOpenAPIParams([...queryParams, ...pathParams]),
    body: convertOpenAPIBody(operation, parameters, schemas),
    auth: convertOpenAPISecurity(operation.security, securitySchemes),
  };
}

function convertOpenAPIParams(params: OpenAPIParameter[]): KeyValue[] {
  return params.map(param => ({
    id: uuidv4(),
    key: param.name,
    value: param.schema?.default?.toString() || param.default?.toString() || '',
    enabled: true,
    description: param.description,
  }));
}

function convertOpenAPIHeaders(params: OpenAPIParameter[]): KeyValue[] {
  return params.map(param => ({
    id: uuidv4(),
    key: param.name,
    value: param.schema?.default?.toString() || param.default?.toString() || '',
    enabled: true,
    description: param.description,
  }));
}

function convertOpenAPIBody(
  operation: OpenAPIOperation,
  parameters: OpenAPIParameter[],
  schemas?: Record<string, OpenAPISchema>
): HttpRequest['body'] {
  // OpenAPI 3.x requestBody
  if (operation.requestBody?.content) {
    const content = operation.requestBody.content;

    // Check for JSON
    if (content['application/json']) {
      const mediaType = content['application/json'];
      const example = mediaType.example ||
        (mediaType.examples && Object.values(mediaType.examples)[0]?.value) ||
        generateExampleFromSchema(mediaType.schema, schemas);

      return {
        type: 'json',
        raw: example ? JSON.stringify(example, null, 2) : '',
      };
    }

    // Check for XML
    if (content['application/xml'] || content['text/xml']) {
      const mediaType = content['application/xml'] ?? content['text/xml'];
      return {
        type: 'xml',
        raw: mediaType?.example?.toString() || '',
      };
    }

    // Check for form data
    if (content['multipart/form-data']) {
      return { type: 'form-data' };
    }

    // Check for URL encoded
    if (content['application/x-www-form-urlencoded']) {
      return { type: 'x-www-form-urlencoded' };
    }

    // Check for text
    if (content['text/plain']) {
      return {
        type: 'text',
        raw: content['text/plain'].example?.toString() || '',
      };
    }
  }

  // Swagger 2.0 body parameter
  const bodyParam = parameters.find(p => p.in === 'body');
  if (bodyParam?.schema) {
    const example = generateExampleFromSchema(bodyParam.schema, schemas);
    return {
      type: 'json',
      raw: example ? JSON.stringify(example, null, 2) : '',
    };
  }

  // Swagger 2.0 formData parameters
  const formDataParams = parameters.filter(p => p.in === 'formData');
  if (formDataParams.length > 0) {
    return { type: 'form-data' };
  }

  return { type: 'none' };
}

function generateExampleFromSchema(
  schema: OpenAPISchema | undefined,
  schemas?: Record<string, OpenAPISchema>,
  visited: WeakSet<object> = new WeakSet()
): unknown {
  if (!schema) return undefined;

  // Check for circular reference using object identity
  // (swagger-parser dereferences $refs, creating actual circular objects)
  if (visited.has(schema)) {
    return {}; // Circular reference detected, return empty object
  }
  visited.add(schema);

  // Handle $ref (if not already dereferenced)
  if (schema.$ref && schemas) {
    const refName = schema.$ref.split('/').pop();
    if (refName && schemas[refName]) {
      return generateExampleFromSchema(schemas[refName], schemas, visited);
    }
    return undefined;
  }

  // Return example if provided
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;

  // Generate based on type
  switch (schema.type) {
    case 'object':
      if (schema.properties) {
        const obj: Record<string, unknown> = {};
        for (const [key, prop] of Object.entries(schema.properties)) {
          obj[key] = generateExampleFromSchema(prop, schemas, visited);
        }
        return obj;
      }
      return {};
    case 'array':
      if (schema.items) {
        return [generateExampleFromSchema(schema.items, schemas, visited)];
      }
      return [];
    case 'string':
      if (schema.enum) return schema.enum[0];
      if (schema.format === 'date') return '2024-01-01';
      if (schema.format === 'date-time') return '2024-01-01T00:00:00Z';
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      return 'string';
    case 'integer':
    case 'number':
      if (schema.enum) return schema.enum[0];
      return 0;
    case 'boolean':
      return false;
    default:
      return undefined;
  }
}

function convertOpenAPISecurity(
  security?: Array<Record<string, string[]>>,
  securitySchemes?: Record<string, OpenAPISecurityScheme>
): AuthConfig {
  if (!security || security.length === 0 || !securitySchemes) {
    return { type: 'none' };
  }

  // Use the first security requirement
  const securityReq = security[0];
  if (!securityReq) return { type: 'none' };

  const schemeName = Object.keys(securityReq)[0];
  if (!schemeName) return { type: 'none' };

  const scheme = securitySchemes[schemeName];

  if (!scheme) return { type: 'none' };

  switch (scheme.type) {
    case 'http':
      if (scheme.scheme === 'basic') {
        return {
          type: 'basic',
          basic: { username: '', password: '' },
        };
      }
      if (scheme.scheme === 'bearer') {
        return {
          type: 'bearer',
          bearer: { token: '' },
        };
      }
      break;
    case 'apiKey':
      return {
        type: 'api-key',
        apiKey: {
          key: scheme.name || '',
          value: '',
          in: scheme.in === 'query' ? 'query' : 'header',
        },
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: { accessToken: '' },
      };
    // Swagger 2.0 types
    case 'basic':
      return {
        type: 'basic',
        basic: { username: '', password: '' },
      };
  }

  return { type: 'none' };
}
