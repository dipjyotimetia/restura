import { v4 as uuidv4 } from 'uuid';
import { coerceHttpMethod, type ImportWarning } from './types';
import type {
  AuthConfig,
  Collection,
  CollectionItem,
  FormDataItem,
  HttpMethod,
  HttpRequest,
  KeyValue,
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPISchema,
  OpenAPISecurityScheme,
} from '@/types';

/**
 * `swagger-parser` references the Node `Buffer` global while dereferencing
 * `$ref`s. The renderer has no native Buffer, so the npm `buffer` polyfill
 * is aliased into place by `vite.config.mts`. We attach it to `globalThis`
 * here — dynamically — so the polyfill chunk never lands in the main bundle
 * for users who don't import OpenAPI specs (~12 KB saved).
 */
async function ensureBufferPolyfill(): Promise<void> {
  if (typeof globalThis !== 'undefined' && 'Buffer' in globalThis) return;
  const mod = (await import('buffer')) as { Buffer: unknown };
  (globalThis as unknown as { Buffer: unknown }).Buffer = mod.Buffer;
}

export async function importOpenAPICollection(
  openApiData: unknown,
  warnings?: ImportWarning[]
): Promise<Collection> {
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

  await ensureBufferPolyfill();
  const { default: SwaggerParser } = await import('@apidevtools/swagger-parser');

  let api: OpenAPIDocument;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- swagger-parser accepts any
    api = (await SwaggerParser.dereference(openApiData as any, {
      resolve: { external: false },
    })) as unknown as OpenAPIDocument;
  } catch (error) {
    throw new Error(
      `Failed to parse OpenAPI document: ${error instanceof Error ? error.message : 'Unknown parsing error'}`
    );
  }

  const isSwagger2 = 'swagger' in api && api.swagger;

  let baseUrl = '';
  if (isSwagger2) {
    baseUrl = `${api.schemes?.[0] || 'https'}://${api.host || 'localhost'}${api.basePath || ''}`;
  } else if (api.servers?.[0]) {
    const server = api.servers[0];
    baseUrl = server.url;
    if (server.variables) {
      for (const [varName, varDef] of Object.entries(server.variables)) {
        baseUrl = baseUrl.replace(`{${varName}}`, varDef.default || varDef.enum?.[0] || '');
      }
    }
  }

  const securitySchemes = isSwagger2 ? api.securityDefinitions : api.components?.securitySchemes;

  const collection: Collection = {
    id: uuidv4(),
    name: api.info.title,
    description: api.info.description,
    items: [],
  };

  const taggedOperations = new Map<string, CollectionItem[]>();
  const untaggedOperations: CollectionItem[] = [];

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

      const allParams = [...(pathItem.parameters || []), ...(operation.parameters || [])];
      const opName = operation.summary || operation.operationId || `${method} ${path}`;
      const request = convertOpenAPIOperation(
        path,
        // TRACE (valid OpenAPI, outside Restura's method union) downgrades
        // to GET with a warning rather than failing the import gate.
        coerceHttpMethod(method, opName, warnings),
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

      const tag = operation.tags?.[0];
      if (tag) {
        if (!taggedOperations.has(tag)) taggedOperations.set(tag, []);
        taggedOperations.get(tag)!.push(item);
      } else {
        untaggedOperations.push(item);
      }
    }
  }

  for (const [tagName, items] of taggedOperations) {
    collection.items.push({ id: uuidv4(), name: tagName, type: 'folder', items });
  }
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
  const url = `${baseUrl}${path.replace(/\{([^}]+)\}/g, '{{$1}}')}`;

  const queryParams = parameters.filter((p) => p.in === 'query');
  const headerParams = parameters.filter((p) => p.in === 'header');
  const cookieParams = parameters.filter((p) => p.in === 'cookie');

  const headers = convertOpenAPIHeaders(headerParams);

  if (cookieParams.length > 0) {
    const cookieValue = cookieParams
      .map((p) => {
        const value =
          p.schema?.example?.toString() ||
          p.example?.toString() ||
          p.schema?.default?.toString() ||
          p.default?.toString() ||
          '';
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

  const contentTypeMap: Record<string, string> = {
    json: 'application/json',
    xml: 'application/xml',
    text: 'text/plain',
    'form-data': 'multipart/form-data',
    'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
    graphql: 'application/json',
  };
  const contentType =
    body.type !== 'none' && body.type !== 'binary' ? contentTypeMap[body.type] : undefined;
  if (contentType && !headers.some((h) => h.key.toLowerCase() === 'content-type')) {
    headers.push({ id: uuidv4(), key: 'Content-Type', value: contentType, enabled: true });
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
  return params.map((param) => ({
    id: uuidv4(),
    key: param.name,
    value:
      param.schema?.example?.toString() ||
      param.example?.toString() ||
      param.schema?.default?.toString() ||
      param.default?.toString() ||
      '',
    enabled: true,
    description: param.description,
  }));
}

function convertOpenAPIHeaders(params: OpenAPIParameter[]): KeyValue[] {
  return params.map((param) => ({
    id: uuidv4(),
    key: param.name,
    value:
      param.schema?.example?.toString() ||
      param.example?.toString() ||
      param.schema?.default?.toString() ||
      param.default?.toString() ||
      '',
    enabled: true,
    description: param.description,
  }));
}

function convertOpenAPIBody(
  operation: OpenAPIOperation,
  parameters: OpenAPIParameter[],
  schemas?: Record<string, OpenAPISchema>
): HttpRequest['body'] {
  if (operation.requestBody?.content) {
    const content = operation.requestBody.content;

    if (content['application/json']) {
      const mediaType = content['application/json'];
      const example =
        mediaType.example ||
        (mediaType.examples && Object.values(mediaType.examples)[0]?.value) ||
        generateExampleFromSchema(mediaType.schema, schemas);
      return { type: 'json', raw: example ? JSON.stringify(example, null, 2) : '' };
    }

    if (content['application/xml'] || content['text/xml']) {
      const mediaType = content['application/xml'] ?? content['text/xml'];
      return { type: 'xml', raw: mediaType?.example?.toString() || '' };
    }

    if (content['multipart/form-data']) {
      return {
        type: 'form-data',
        formData: generateFormDataFromSchema(content['multipart/form-data'].schema),
      };
    }

    if (content['application/x-www-form-urlencoded']) {
      return {
        type: 'x-www-form-urlencoded',
        formData: generateFormDataFromSchema(content['application/x-www-form-urlencoded'].schema),
      };
    }

    if (content['text/plain']) {
      return { type: 'text', raw: content['text/plain'].example?.toString() || '' };
    }

    if (content['application/octet-stream']) {
      return { type: 'binary' };
    }
  }

  // Swagger 2.0 body parameter
  const bodyParam = parameters.find((p) => p.in === 'body');
  if (bodyParam?.schema) {
    const example = generateExampleFromSchema(bodyParam.schema, schemas);
    return { type: 'json', raw: example ? JSON.stringify(example, null, 2) : '' };
  }

  // Swagger 2.0 formData parameters
  const formDataParams = parameters.filter((p) => p.in === 'formData');
  if (formDataParams.length > 0) {
    const formData: FormDataItem[] = formDataParams.map((param) => ({
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

function generateFormDataFromSchema(schema: OpenAPISchema | undefined): FormDataItem[] {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties).map(([key, prop]) => ({
    id: uuidv4(),
    key,
    value: prop.example?.toString() || prop.default?.toString() || generateSimpleValue(prop),
    enabled: true,
    description: prop.description,
    type: 'text' as const,
  }));
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
  if (visited.has(schema)) return {};
  visited.add(schema);

  if (schema.$ref && schemas) {
    const refName = schema.$ref.split('/').pop();
    if (refName && schemas[refName])
      return generateExampleFromSchema(schemas[refName], schemas, visited);
    return undefined;
  }

  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;

  if (schema.allOf && Array.isArray(schema.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const subSchema of schema.allOf) {
      const result = generateExampleFromSchema(subSchema, schemas, visited);
      if (result && typeof result === 'object' && !Array.isArray(result))
        Object.assign(merged, result);
    }
    return merged;
  }

  if (schema.oneOf?.length) return generateExampleFromSchema(schema.oneOf[0], schemas, visited);
  if (schema.anyOf?.length) return generateExampleFromSchema(schema.anyOf[0], schemas, visited);

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
      return schema.items ? [generateExampleFromSchema(schema.items, schemas, visited)] : [];
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
  if (!security?.length || !securitySchemes) return { type: 'none' };

  const securityReq = security[0];
  if (!securityReq) return { type: 'none' };

  const schemeName = Object.keys(securityReq)[0];
  if (!schemeName) return { type: 'none' };

  const scheme = securitySchemes[schemeName];
  const scopes = securityReq[schemeName];
  if (!scheme) return { type: 'none' };

  switch (scheme.type) {
    case 'http':
      if (scheme.scheme === 'basic')
        return { type: 'basic', basic: { username: '', password: '' } };
      if (scheme.scheme === 'bearer') return { type: 'bearer', bearer: { token: '' } };
      if (scheme.scheme === 'digest')
        return { type: 'digest', digest: { username: '', password: '' } };
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
        oauth2: { accessToken: '', scopes: scopes?.length ? scopes : undefined },
      };
    case 'basic':
      return { type: 'basic', basic: { username: '', password: '' } };
  }

  return { type: 'none' };
}
