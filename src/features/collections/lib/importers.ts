import { Collection, CollectionItem, PostmanCollection, InsomniaCollection, HttpRequest, KeyValue, AuthConfig, OpenAPIDocument, OpenAPIOperation, OpenAPIParameter, OpenAPISecurityScheme, OpenAPISchema, HttpMethod, FormDataItem } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Collection as PostmanSDKCollection, Item, ItemGroup, Request, RequestAuth, RequestBody, QueryParam, Header, FormParam, Variable } from 'postman-collection';

// Helper to extract description content
function getDescriptionContent(desc: string | { content?: string } | undefined): string | undefined {
  if (!desc) return undefined;
  if (typeof desc === 'string') return desc;
  return desc.content;
}

// Postman Collection Importer - using official postman-collection SDK
export function importPostmanCollection(postmanData: PostmanCollection): Collection {
  // Parse using official SDK for complete Postman format support
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkCollection = new PostmanSDKCollection(postmanData as any);

  // Extract collection variables
  const variables: KeyValue[] = [];
  if (sdkCollection.variables) {
    sdkCollection.variables.each((variable: Variable) => {
      variables.push({
        id: uuidv4(),
        key: variable.key || '',
        value: variable.value?.toString() || '',
        enabled: !variable.disabled,
        description: getDescriptionContent(variable.description),
      });
    });
  }

  const collection: Collection = {
    id: uuidv4(),
    name: sdkCollection.name || 'Imported Collection',
    description: getDescriptionContent(sdkCollection.description),
    items: [],
    auth: sdkCollection.auth ? convertPostmanSDKAuth(sdkCollection.auth) : undefined,
    variables: variables.length > 0 ? variables : undefined,
  };

  // Convert items recursively
  sdkCollection.items.each((item) => {
    const converted = convertPostmanSDKItem(item, collection.auth);
    if (converted) {
      collection.items.push(converted);
    }
  });

  return collection;
}

function convertPostmanSDKItem(item: Item | ItemGroup<Item>, parentAuth?: AuthConfig): CollectionItem | null {
  // Check if it's a folder (ItemGroup)
  if (ItemGroup.isItemGroup(item)) {
    const group = item as ItemGroup<Item>;
    const items: CollectionItem[] = [];

    group.items.each((subItem) => {
      const converted = convertPostmanSDKItem(subItem, parentAuth);
      if (converted) {
        items.push(converted);
      }
    });

    return {
      id: uuidv4(),
      name: group.name || 'Unnamed Folder',
      type: 'folder',
      items,
    };
  }

  // It's a request item
  const requestItem = item as Item;
  const request = requestItem.request;

  if (!request) return null;

  const httpRequest: HttpRequest = {
    id: uuidv4(),
    name: requestItem.name || 'Unnamed Request',
    type: 'http',
    method: (request.method as HttpRequest['method']) || 'GET',
    url: request.url?.toString() || '',
    headers: convertPostmanSDKHeaders(request.headers),
    params: convertPostmanSDKParams(request.url?.query),
    body: convertPostmanSDKBody(request.body),
    auth: request.auth ? convertPostmanSDKAuth(request.auth) : (parentAuth || { type: 'none' }),
    preRequestScript: extractScript(requestItem.events, 'prerequest'),
    testScript: extractScript(requestItem.events, 'test'),
  };

  return {
    id: uuidv4(),
    name: requestItem.name || 'Unnamed Request',
    type: 'request',
    request: httpRequest,
  };
}

function extractScript(events: Item['events'], listen: string): string | undefined {
  if (!events) return undefined;

  let script: string | undefined;
  events.each((event) => {
    if (event.listen === listen && event.script) {
      const exec = event.script.exec;
      if (Array.isArray(exec)) {
        script = exec.join('\n');
      } else if (typeof exec === 'string') {
        script = exec;
      }
    }
  });

  return script;
}

function convertPostmanSDKHeaders(headers: Request['headers']): KeyValue[] {
  if (!headers) return [];

  const result: KeyValue[] = [];
  headers.each((header: Header) => {
    result.push({
      id: uuidv4(),
      key: header.key || '',
      value: header.value || '',
      enabled: !header.disabled,
      description: getDescriptionContent(header.description),
    });
  });

  return result;
}

function convertPostmanSDKParams(queryParams: Request['url']['query'] | undefined): KeyValue[] {
  if (!queryParams) return [];

  const result: KeyValue[] = [];
  queryParams.each((param: QueryParam) => {
    result.push({
      id: uuidv4(),
      key: param.key || '',
      value: param.value || '',
      enabled: !param.disabled,
      description: getDescriptionContent(param.description),
    });
  });

  return result;
}

function convertPostmanSDKBody(body: RequestBody | undefined): HttpRequest['body'] {
  if (!body) return { type: 'none' };

  const mode = body.mode;

  // Cast to any to access all Postman body properties
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bodyAny = body as any;

  switch (mode) {
    case 'raw': {
      const raw = body.raw || '';
      // Detect content type from options
      const language = bodyAny.options?.raw?.language;
      let type: HttpRequest['body']['type'] = 'text';

      if (language === 'json') type = 'json';
      else if (language === 'xml') type = 'xml';
      else if (language === 'javascript') type = 'text';
      else if (language === 'html') type = 'text';

      return { type, raw };
    }

    case 'formdata': {
      const formData: FormDataItem[] = [];
      body.formdata?.each((param: FormParam) => {
        // Check if this is a file type parameter
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const paramAny = param as any;
        const isFile = paramAny.type === 'file';
        formData.push({
          id: uuidv4(),
          key: param.key || '',
          value: isFile ? (paramAny.src || '') : (param.value || ''),
          enabled: !param.disabled,
          description: getDescriptionContent(param.description),
          type: isFile ? 'file' : 'text',
        });
      });
      return { type: 'form-data', formData };
    }

    case 'urlencoded': {
      const formData: FormDataItem[] = [];
      body.urlencoded?.each((param: QueryParam) => {
        formData.push({
          id: uuidv4(),
          key: param.key || '',
          value: param.value || '',
          enabled: !param.disabled,
          description: getDescriptionContent(param.description),
          type: 'text',
        });
      });
      return { type: 'x-www-form-urlencoded', formData };
    }

    case 'graphql': {
      const graphql = bodyAny.graphql;
      const query = graphql?.query || '';
      const variables = graphql?.variables;

      let raw = query;
      if (variables) {
        try {
          const parsed = typeof variables === 'string' ? JSON.parse(variables) : variables;
          raw = JSON.stringify({ query, variables: parsed }, null, 2);
        } catch {
          raw = JSON.stringify({ query, variables: {} }, null, 2);
        }
      }

      return { type: 'graphql', raw };
    }

    case 'file':
      return { type: 'binary' };

    default:
      return { type: 'none' };
  }
}

function convertPostmanSDKAuth(auth: RequestAuth): AuthConfig {
  const type = auth.type;

  const getParam = (key: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = (auth as any).parameters?.() || [];
    const param = params.find((p: Variable) => p.key === key);
    return param?.value?.toString() || '';
  };

  switch (type) {
    case 'basic':
      return {
        type: 'basic',
        basic: {
          username: getParam('username'),
          password: getParam('password'),
        },
      };

    case 'bearer':
      return {
        type: 'bearer',
        bearer: {
          token: getParam('token'),
        },
      };

    case 'apikey':
      return {
        type: 'api-key',
        apiKey: {
          key: getParam('key'),
          value: getParam('value'),
          in: getParam('in') === 'query' ? 'query' : 'header',
        },
      };

    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: getParam('accessToken'),
          tokenType: getParam('tokenType'),
        },
      };

    case 'digest':
      return {
        type: 'digest',
        digest: {
          username: getParam('username'),
          password: getParam('password'),
        },
      };

    case 'awsv4':
      return {
        type: 'aws-signature',
        awsSignature: {
          accessKey: getParam('accessKey'),
          secretKey: getParam('secretKey'),
          region: getParam('region'),
          service: getParam('service'),
        },
      };

    case 'noauth':
    default:
      return { type: 'none' };
  }
}

// Insomnia Collection Importer
export function importInsomniaCollection(insomniaData: InsomniaCollection): Collection {
  const workspaces = insomniaData.resources.filter((r) => r._type === 'workspace');
  const requests = insomniaData.resources.filter((r) => r._type === 'request');
  const folders = insomniaData.resources.filter((r) => r._type === 'request_group');
  const environments = insomniaData.resources.filter((r) => r._type === 'environment');

  const workspace = workspaces[0];

  // Extract variables from base environment (one without parentId or with workspace as parent)
  const variables: KeyValue[] = [];
  const baseEnv = environments.find(
    (env) => !env.parentId || (workspace && env.parentId === workspace._id)
  );

  if (baseEnv?.data && typeof baseEnv.data === 'object') {
    for (const [key, value] of Object.entries(baseEnv.data)) {
      variables.push({
        id: uuidv4(),
        key,
        value: String(value ?? ''),
        enabled: true,
      });
    }
  }

  const collection: Collection = {
    id: uuidv4(),
    name: workspace?.name || 'Imported Collection',
    items: [],
    variables: variables.length > 0 ? variables : undefined,
  };

  // Build folder structure with proper nesting support
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

  // Add requests to their parent folders
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

    // Add to parent folder if it exists
    if (req.parentId && folderMap.has(req.parentId)) {
      folderMap.get(req.parentId)!.items!.push(item);
    } else {
      // Add to root if no parent, parent is workspace, or parent not found (orphaned)
      collection.items.push(item);
    }
  });

  // Build nested folder hierarchy
  folders.forEach((folder) => {
    const item = folderMap.get(folder._id);
    if (!item) return;

    // Check if this folder's parent is another folder
    if (folder.parentId && folderMap.has(folder.parentId)) {
      // Add to parent folder
      folderMap.get(folder.parentId)!.items!.push(item);
    } else {
      // Add to root if no parent, parent is workspace, or parent not found (orphaned)
      collection.items.push(item);
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

function convertInsomniaBody(body: { mimeType?: string; text?: string; params?: Array<{ name: string; value: string; disabled?: boolean }> } | undefined): HttpRequest['body'] {
  if (!body) return { type: 'none' };

  const mimeTypeMap: Record<string, HttpRequest['body']['type']> = {
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'text/plain': 'text',
    'application/x-www-form-urlencoded': 'x-www-form-urlencoded',
    'multipart/form-data': 'form-data',
    'application/graphql': 'graphql',
  };

  const bodyType = (body.mimeType && mimeTypeMap[body.mimeType]) || 'text';

  // Handle form data with params
  if ((bodyType === 'form-data' || bodyType === 'x-www-form-urlencoded') && body.params) {
    const formData: FormDataItem[] = body.params.map((param) => ({
      id: uuidv4(),
      key: param.name,
      value: param.value,
      enabled: !param.disabled,
      type: 'text' as const,
    }));
    return { type: bodyType, formData };
  }

  return {
    type: bodyType,
    raw: body.text,
  };
}

function convertInsomniaAuth(auth: { type?: string; username?: string; password?: string; token?: string; key?: string; value?: string; addTo?: string; accessToken?: string; grantType?: string; authorizationUrl?: string; accessTokenUrl?: string; clientId?: string; clientSecret?: string; scope?: string } | undefined): AuthConfig {
  if (!auth || !auth.type) return { type: 'none' };

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
          tokenType: auth.grantType,
        },
      };
    case 'digest':
      return {
        type: 'digest',
        digest: {
          username: auth.username || '',
          password: auth.password || '',
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

  // Determine base URL with server variable interpolation
  let baseUrl = '';
  if (isSwagger2) {
    baseUrl = `${api.schemes?.[0] || 'https'}://${api.host || 'localhost'}${api.basePath || ''}`;
  } else if (api.servers?.[0]) {
    const server = api.servers[0];
    baseUrl = server.url;

    // Interpolate server variables
    if (server.variables) {
      for (const [varName, varDef] of Object.entries(server.variables)) {
        const value = varDef.default || varDef.enum?.[0] || '';
        baseUrl = baseUrl.replace(`{${varName}}`, value);
      }
    }
  }

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
      ['TRACE', pathItem.trace],
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
  const cookieParams = parameters.filter(p => p.in === 'cookie');

  // Convert headers including cookie params
  const headers = convertOpenAPIHeaders(headerParams);

  // Add Cookie header if there are cookie parameters
  if (cookieParams.length > 0) {
    const cookieValue = cookieParams
      .map(p => {
        const value = p.schema?.example?.toString() || p.example?.toString() || p.schema?.default?.toString() || p.default?.toString() || '';
        return `${p.name}=${value}`;
      })
      .join('; ');
    headers.push({
      id: uuidv4(),
      key: 'Cookie',
      value: cookieValue,
      enabled: true,
      description: 'Cookie parameters',
    });
  }

  const body = convertOpenAPIBody(operation, parameters, schemas);

  // Add Content-Type header based on body type
  const contentTypeMap: Record<string, string> = {
    'json': 'application/json',
    'xml': 'application/xml',
    'text': 'text/plain',
    'form-data': 'multipart/form-data',
    'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
    'graphql': 'application/json',
  };

  const contentType = body.type !== 'none' && body.type !== 'binary' ? contentTypeMap[body.type] : undefined;
  if (contentType) {
    // Check if Content-Type already exists
    const hasContentType = headers.some(h => h.key.toLowerCase() === 'content-type');
    if (!hasContentType) {
      headers.push({
        id: uuidv4(),
        key: 'Content-Type',
        value: contentType,
        enabled: true,
      });
    }
  }

  return {
    id: uuidv4(),
    name: operation.summary || operation.operationId || `${method} ${path}`,
    type: 'http',
    method,
    url,
    headers,
    params: convertOpenAPIParams(queryParams),
    body,
    auth: convertOpenAPISecurity(operation.security, securitySchemes),
  };
}

function convertOpenAPIParams(params: OpenAPIParameter[]): KeyValue[] {
  return params.map(param => ({
    id: uuidv4(),
    key: param.name,
    value: param.schema?.example?.toString() || param.example?.toString() || param.schema?.default?.toString() || param.default?.toString() || '',
    enabled: true,
    description: param.description,
  }));
}

function convertOpenAPIHeaders(params: OpenAPIParameter[]): KeyValue[] {
  return params.map(param => ({
    id: uuidv4(),
    key: param.name,
    value: param.schema?.example?.toString() || param.example?.toString() || param.schema?.default?.toString() || param.default?.toString() || '',
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

    // Check for form data with field generation
    if (content['multipart/form-data']) {
      const mediaType = content['multipart/form-data'];
      const formData = generateFormDataFromSchema(mediaType.schema);
      return { type: 'form-data', formData };
    }

    // Check for URL encoded with field generation
    if (content['application/x-www-form-urlencoded']) {
      const mediaType = content['application/x-www-form-urlencoded'];
      const formData = generateFormDataFromSchema(mediaType.schema);
      return { type: 'x-www-form-urlencoded', formData };
    }

    // Check for text
    if (content['text/plain']) {
      return {
        type: 'text',
        raw: content['text/plain'].example?.toString() || '',
      };
    }

    // Check for binary/octet-stream
    if (content['application/octet-stream']) {
      return { type: 'binary' };
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
    const formData: FormDataItem[] = formDataParams.map(param => ({
      id: uuidv4(),
      key: param.name,
      value: param.default?.toString() || param.example?.toString() || '',
      enabled: true,
      description: param.description,
      type: 'text' as const,
    }));
    return { type: 'form-data', formData };
  }

  return { type: 'none' };
}

function generateFormDataFromSchema(
  schema: OpenAPISchema | undefined
): FormDataItem[] {
  if (!schema?.properties) return [];

  return Object.entries(schema.properties).map(([key, prop]) => {
    const value = prop.example?.toString() ||
      prop.default?.toString() ||
      generateSimpleValue(prop);

    return {
      id: uuidv4(),
      key,
      value,
      enabled: true,
      description: prop.description,
      type: 'text' as const,
    };
  });
}

function generateSimpleValue(schema: OpenAPISchema): string {
  switch (schema.type) {
    case 'string':
      if (schema.enum) return String(schema.enum[0]);
      if (schema.format === 'date') return '2024-01-01';
      if (schema.format === 'date-time') return '2024-01-01T00:00:00Z';
      if (schema.format === 'email') return 'user@example.com';
      return '';
    case 'integer':
    case 'number':
      return '0';
    case 'boolean':
      return 'false';
    default:
      return '';
  }
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

  // Handle allOf - merge all schemas
  if (schema.allOf && Array.isArray(schema.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const subSchema of schema.allOf) {
      const result = generateExampleFromSchema(subSchema, schemas, visited);
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        Object.assign(merged, result);
      }
    }
    return merged;
  }

  // Handle oneOf/anyOf - use first schema
  if (schema.oneOf && Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateExampleFromSchema(schema.oneOf[0], schemas, visited);
  }

  if (schema.anyOf && Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return generateExampleFromSchema(schema.anyOf[0], schemas, visited);
  }

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
      if (schema.format === 'uri') return 'https://example.com';
      if (schema.format === 'hostname') return 'example.com';
      if (schema.format === 'ipv4') return '192.168.1.1';
      if (schema.format === 'ipv6') return '::1';
      return 'string';
    case 'integer':
    case 'number':
      if (schema.enum) return schema.enum[0];
      if (schema.minimum !== undefined) return schema.minimum;
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
  const scopes = securityReq[schemeName]; // OAuth2 scopes array

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
      if (scheme.scheme === 'digest') {
        return {
          type: 'digest',
          digest: { username: '', password: '' },
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
        oauth2: {
          accessToken: '',
          scopes: scopes && scopes.length > 0 ? scopes : undefined,
        },
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
