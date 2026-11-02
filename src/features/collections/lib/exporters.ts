import {
  exportPostmanV21,
  type PostmanV21Collection,
  type PostmanV21Export,
} from '@shared/collections/postman';
import { redactVariableValue } from '@shared/collections/postman/text-redaction';
import { isKnownHttpMethod, normalizeHttpMethod } from '@shared/protocol/http-method';
import { v4 as uuidv4 } from 'uuid';
import { internalToOC, serializeOpenCollectionYAML } from '@/lib/opencollection';
import type { SecretValue } from '@/lib/shared/secretRef';
import type {
  AuthConfig,
  Collection,
  CollectionItem,
  Environment,
  HttpRequest,
  InsomniaResource,
} from '@/types';

/**
 * Formats that still report through string warnings. Postman v2.1 / v3 use
 * the structured export report instead (`shared/collections/postman/export-report.ts`).
 */
export type CollectionExportFormat = 'insomnia' | 'opencollection';

/** User-visible advisories for data a target format cannot faithfully carry. */
export function getCollectionExportWarnings(
  collection: Collection,
  format: CollectionExportFormat,
  environments: readonly Environment[] = []
): string[] {
  const warnings = new Set<string>();
  if (format === 'opencollection') {
    const leftOut = environments
      .filter((environment) => environment.collectionId === collection.id)
      .flatMap((environment) => environment.variables ?? [])
      .some(
        (variable) =>
          !variable.private &&
          !variable.secret &&
          !variable.secretRef &&
          redactVariableValue(variable.key, variable.value) !== variable.value
      );
    if (leftOut) warnings.add('Credentials in environment variables were not exported');
  }
  const visit = (items: CollectionItem[]) => {
    for (const item of items) {
      if (item.type === 'folder') {
        if (item.contractSpec) warnings.add('Folder contract attachments are not exported');
        if (format === 'insomnia' && (item.auth || item.preRequestScript || item.testScript)) {
          warnings.add('Insomnia export omits folder auth and scripts');
        }
        visit(item.items ?? []);
        continue;
      }
      if (!item.request) continue;
      if (item.request.type !== 'http') {
        if (format !== 'opencollection') {
          warnings.add(
            `${item.request.type.toUpperCase()} requests are exported as non-runnable stubs`
          );
        }
      }
      const scripted =
        'preRequestScript' in item.request &&
        (item.request.preRequestScript || item.request.testScript);
      if (format === 'insomnia' && scripted) {
        warnings.add('Insomnia export omits request scripts');
      }
    }
  };
  visit(collection.items);
  if (format !== 'opencollection' && collection.contractSpec) {
    warnings.add('Attached contract specs are not exported');
  }
  if (
    format === 'insomnia' &&
    (collection.auth ||
      collection.variables?.length ||
      collection.preRequestScript ||
      collection.testScript)
  ) {
    warnings.add('Insomnia export omits collection auth, variables, and scripts');
  }
  return [...warnings];
}

/**
 * Postman v2.1 (single JSON file, Newman) — a thin call to the shared
 * exporter (`shared/collections/postman/export-v2.ts`, #1229). Callers apply
 * the "include secrets" redaction first. Use {@link exportToPostmanV21} for
 * the structured export report.
 */
export function exportToPostman(collection: Collection): PostmanV21Collection {
  return exportPostmanV21(collection).collection;
}

/** Postman v2.1 collection JSON plus the structured export report. */
export function exportToPostmanV21(collection: Collection): PostmanV21Export {
  return exportPostmanV21(collection);
}

/**
 * Append a request's enabled params to its URL as a query string. `encode`
 * percent-encodes keys/values (HAR wants encoded URLs).
 */
function appendQueryString(
  url: string,
  params: HttpRequest['params'],
  { encode = false }: { encode?: boolean } = {}
): string {
  const enabled = params.filter((p) => p.enabled && p.key);
  if (enabled.length === 0) return url;
  const qs = enabled
    .map((p) =>
      encode ? `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}` : `${p.key}=${p.value}`
    )
    .join('&');
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}

/**
 * Render a SecretValue for text-only export formats (Insomnia, Bruno).
 * Inline values become plaintext (mirrors pre-SecretRef behaviour). Handles
 * become a `{{handle:<label>}}` placeholder so the export round-trips a
 * reference without leaking the keychain plaintext.
 */
function exportSecretValue(value: SecretValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value.kind === 'inline') return value.value;
  if (value.kind === 'external')
    return `{{external:${value.provider}:${value.profileId}:${value.secretId}${value.selector ? `:${value.selector}` : ''}}}`;
  return `{{handle:${value.label ?? value.id}}}`;
}

// Export to Insomnia Format
export function exportToInsomnia(collection: Collection): {
  _type: string;
  __export_format: number;
  __export_date: string;
  __export_source: string;
  resources: InsomniaResource[];
} {
  const resources: InsomniaResource[] = [];

  // Add workspace
  const workspaceId = `wrk_${generateId()}`;
  resources.push({
    _id: workspaceId,
    _type: 'workspace',
    name: collection.name,
    description: collection.description || '',
  });

  // Process items
  function processItem(item: CollectionItem, parentId: string) {
    if (item.type === 'folder') {
      const folderId = `fld_${generateId()}`;
      resources.push({
        _id: folderId,
        _type: 'request_group',
        name: item.name,
        parentId,
      });

      (item.items || []).forEach((child) => processItem(child, folderId));
    } else {
      // Insomnia supports only HTTP-style requests; emit a stub for other protocols.
      const request = item.request;
      if (request?.type !== 'http') {
        resources.push({
          _id: `req_${generateId()}`,
          _type: 'request',
          name: request
            ? `${item.name} [${request.type.toUpperCase()} — not supported in Insomnia]`
            : item.name,
          method: 'GET',
          url: request && 'url' in request ? request.url : '',
          parentId,
        });
        return;
      }
      const requestId = `req_${generateId()}`;

      resources.push({
        _id: requestId,
        _type: 'request',
        name: item.name,
        method: request.method,
        url: request.url,
        headers: request.headers.map((h) => ({
          name: h.key,
          value: h.value,
          disabled: !h.enabled,
        })),
        parameters: request.params.map((p) => ({
          name: p.key,
          value: p.value,
          disabled: !p.enabled,
        })),
        body: convertBodyToInsomnia(request.body),
        authentication: convertAuthToInsomnia(request.auth),
        parentId,
      });
    }
  }

  collection.items.forEach((item) => processItem(item, workspaceId));

  return {
    _type: 'export',
    __export_format: 4,
    __export_date: new Date().toISOString(),
    __export_source: 'api-client-web',
    resources,
  };
}

function convertBodyToInsomnia(body: HttpRequest['body']): { mimeType: string; text: string } {
  if (body.type === 'none') return { mimeType: 'text/plain', text: '' };

  const mimeTypeMap: Record<string, string> = {
    json: 'application/json',
    xml: 'application/xml',
    text: 'text/plain',
    'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
    'form-data': 'multipart/form-data',
  };

  return {
    mimeType: mimeTypeMap[body.type] || 'text/plain',
    text: body.raw || '',
  };
}

function convertAuthToInsomnia(auth: AuthConfig): {
  type?: string;
  [key: string]: unknown;
} {
  // Insomnia's native export uses an empty authentication object for
  // no-auth; emitting `{ type: 'none' }` made importers (ours included)
  // treat it as an unknown scheme.
  if (auth.type === 'none') return {};
  switch (auth.type) {
    case 'basic':
      return {
        type: 'basic',
        username: auth.basic?.username || '',
        password: exportSecretValue(auth.basic?.password),
      };
    case 'bearer':
      return {
        type: 'bearer',
        token: exportSecretValue(auth.bearer?.token),
      };
    case 'api-key':
      return {
        type: 'apikey',
        key: auth.apiKey?.key || '',
        value: exportSecretValue(auth.apiKey?.value),
        addTo: auth.apiKey?.in === 'query' ? 'queryParams' : 'header',
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        accessToken: exportSecretValue(auth.oauth2?.accessToken),
      };
    default:
      return {};
  }
}

const generateId = uuidv4;

// Export to HAR (HTTP Archive) Format
export function exportToHAR(collection: Collection): object {
  const entries: object[] = [];

  function collectEntries(items: CollectionItem[]) {
    for (const item of items) {
      if (item.type === 'folder') {
        collectEntries(item.items || []);
      } else if (item.request?.type === 'http') {
        const req = item.request;
        const postData = buildHarPostData(req.body);
        const queryString = req.params
          .filter((p) => p.enabled && p.key)
          .map((p) => ({ name: p.key, value: p.value }));
        const headers = req.headers
          .filter((h) => h.enabled && h.key)
          .map((h) => ({ name: h.key, value: h.value }));
        const fullUrl = appendQueryString(req.url, req.params, { encode: true });

        entries.push({
          startedDateTime: '',
          time: 0,
          request: {
            method: req.method,
            url: fullUrl,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers,
            queryString,
            postData: postData ?? undefined,
            headersSize: -1,
            bodySize: postData ? (postData.text?.length ?? 0) : 0,
          },
          response: {
            status: 0,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [],
            content: { size: 0, mimeType: 'text/plain' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        });
      }
    }
  }

  collectEntries(collection.items);

  return {
    log: {
      version: '1.2',
      creator: { name: 'Restura', version: '1.0' },
      entries,
    },
  };
}

function buildHarPostData(body: HttpRequest['body']): { mimeType: string; text: string } | null {
  if (body.type === 'none' || !body.raw) return null;

  const mimeTypeMap: Record<string, string> = {
    json: 'application/json',
    xml: 'application/xml',
    text: 'text/plain',
    'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
    'form-data': 'multipart/form-data',
    graphql: 'application/json',
  };

  return {
    mimeType: mimeTypeMap[body.type] ?? 'text/plain',
    text: body.raw,
  };
}

// Export to OpenAPI 3.0 Format
/**
 * OpenAPI 3.0 path items only allow the fixed operation keys (get, put, post,
 * delete, options, head, patch, trace). Extension methods (#857) such as
 * PROPFIND or QUERY have no slot, so they are skipped and reported through
 * the optional `warnings` sink instead of emitting an invalid document.
 */
export function exportToOpenAPI(collection: Collection, warnings?: string[]): object {
  const paths: Record<string, Record<string, unknown>> = {};

  function collectRequests(items: CollectionItem[]) {
    for (const item of items) {
      if (item.type === 'folder') {
        collectRequests(item.items || []);
      } else if (item.request?.type === 'http') {
        const req = item.request;
        const normalized = normalizeHttpMethod(req.method);
        if (!isKnownHttpMethod(normalized)) {
          warnings?.push(`OpenAPI 3.0 has no operation for ${normalized} — skipped "${item.name}"`);
          continue;
        }
        const pathKey = toOpenAPIPath(req.url);
        const method = normalized.toLowerCase();

        if (!paths[pathKey]) paths[pathKey] = {};

        const parameters: unknown[] = [];

        // Path parameters from {param} placeholders
        const pathParams = pathKey.match(/\{([^}]+)\}/g)?.map((p) => p.slice(1, -1)) ?? [];
        for (const param of pathParams) {
          parameters.push({
            name: param,
            in: 'path',
            required: true,
            schema: { type: 'string' },
          });
        }

        // Query parameters
        req.params
          .filter((p) => p.enabled && p.key)
          .forEach((p) => {
            parameters.push({
              name: p.key,
              in: 'query',
              required: false,
              schema: { type: 'string' },
              example: p.value || undefined,
              description: p.description,
            });
          });

        // Header parameters (excluding Authorization which goes in securitySchemes)
        req.headers
          .filter((h) => h.enabled && h.key && h.key.toLowerCase() !== 'authorization')
          .forEach((h) => {
            parameters.push({
              name: h.key,
              in: 'header',
              required: false,
              schema: { type: 'string' },
              example: h.value || undefined,
            });
          });

        const rawOpId = item.name.replace(/\s+/g, '_').replace(/[^\w]/g, '');
        const operation: Record<string, unknown> = {
          operationId: rawOpId || uuidv4(),
          summary: item.name,
          parameters: parameters.length > 0 ? parameters : undefined,
          responses: {
            '200': { description: 'Successful response' },
            '400': { description: 'Bad request' },
            '401': { description: 'Unauthorized' },
            '500': { description: 'Internal server error' },
          },
        };

        // Request body
        if (req.body.type !== 'none' && req.body.raw) {
          const mimeMap: Record<string, string> = {
            json: 'application/json',
            xml: 'application/xml',
            text: 'text/plain',
            'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
            'form-data': 'multipart/form-data',
            graphql: 'application/json',
          };
          const mime = mimeMap[req.body.type] ?? 'text/plain';
          let schema: Record<string, unknown> = { type: 'string' };
          if (req.body.type === 'json') {
            try {
              const parsed = JSON.parse(req.body.raw);
              schema = jsonToSchema(parsed);
            } catch {
              // keep string schema
            }
          }
          operation['requestBody'] = {
            required: true,
            content: { [mime]: { schema, example: req.body.raw } },
          };
        }

        // Security
        const security = authToOpenAPISecurity(req.auth);
        if (security) operation['security'] = [security];

        paths[pathKey][method] = operation;
      }
    }
  }

  collectRequests(collection.items);

  // Collect unique base URLs for servers
  const urls = new Set<string>();
  function extractUrls(items: CollectionItem[]) {
    for (const item of items) {
      if (item.type === 'folder') extractUrls(item.items || []);
      else if (item.request?.type === 'http') {
        try {
          const u = new URL(item.request.url);
          urls.add(`${u.protocol}//${u.host}`);
        } catch {
          // invalid URL
        }
      }
    }
  }
  extractUrls(collection.items);

  return {
    openapi: '3.0.3',
    info: {
      title: collection.name,
      description: collection.description || '',
      version: '1.0.0',
    },
    servers:
      urls.size > 0
        ? Array.from(urls).map((url) => ({ url }))
        : [{ url: 'https://api.example.com' }],
    paths,
  };
}

function toOpenAPIPath(url: string): string {
  try {
    const u = new URL(url);
    // Convert {{variable}} placeholders to {variable} (OpenAPI style)
    return u.pathname.replace(/\{\{(\w+)\}\}/g, '{$1}') || '/';
  } catch {
    // Not a full URL — treat as path
    const path = url.replace(/\{\{(\w+)\}\}/g, '{$1}');
    return path.startsWith('/') ? path : `/${path}`;
  }
}

function jsonToSchema(value: unknown): Record<string, unknown> {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    // Item type is inferred from the first element only — heterogeneous arrays will produce
    // an incomplete schema, which is acceptable for a best-effort export.
    return {
      type: 'array',
      items: value.length > 0 ? jsonToSchema(value[0]) : {},
    };
  }
  if (typeof value === 'object') {
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      properties[k] = jsonToSchema(v);
    }
    return { type: 'object', properties };
  }
  return { type: typeof value };
}

function authToOpenAPISecurity(auth: AuthConfig): Record<string, string[]> | null {
  switch (auth.type) {
    case 'bearer':
    case 'oauth2':
      return { bearerAuth: [] };
    case 'basic':
      return { basicAuth: [] };
    case 'api-key':
      return { apiKey: [] };
    default:
      return null;
  }
}

// Download helper
export function downloadJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export a Restura collection as a bundled OpenCollection v1.0.0 YAML
 * document. Uses the `_oc` passthrough bag from the importer to emit
 * byte-stable YAML when nothing has been edited.
 */
export function exportToOpenCollection(
  collection: Collection,
  environments: Environment[] = []
): string {
  const oc = internalToOC(collection as Collection & { _oc?: unknown });
  const owned = environments.filter((environment) => environment.collectionId === collection.id);
  if (owned.length > 0 || hasPrivateVariables(collection.variables)) {
    const names = new Map(owned.map((environment) => [environment.id, environment.name]));
    const existing = oc.config?.environments?.[0] ?? { name: 'default' };
    const exported = owned.map((environment) => ({
      name: environment.name,
      ...(environment.parentId && names.get(environment.parentId)
        ? { extends: names.get(environment.parentId) }
        : {}),
      ...(portableVariables(environment.variables).length > 0
        ? { variables: portableVariables(environment.variables) }
        : {}),
    }));
    oc.config = { ...(oc.config ?? {}), environments: [existing, ...exported] };
    const privateVariables = [
      privateVariableEntry('default', collection.variables),
      ...owned.map((environment) => privateVariableEntry(environment.name, environment.variables)),
    ].filter((entry): entry is { environment: string; names: string[] } => entry !== undefined);
    const extensions = { ...(oc.extensions ?? {}) } as Record<string, unknown>;
    if (privateVariables.length > 0) extensions['x-restura-private-variables'] = privateVariables;
    else delete extensions['x-restura-private-variables'];
    if (Object.keys(extensions).length > 0) oc.extensions = extensions;
  }
  return serializeOpenCollectionYAML({ ...oc, bundled: true });
}

function portableVariables(
  variables: Collection['variables']
): Array<{ name: string; value?: string; secret?: true }> {
  return (variables ?? [])
    .filter((variable) => !variable.private)
    .map((variable) =>
      variable.secret || variable.secretRef
        ? { name: variable.key, secret: true as const }
        : { name: variable.key, value: redactVariableValue(variable.key, variable.value) }
    );
}

function hasPrivateVariables(variables: Collection['variables']): boolean {
  return (variables ?? []).some((variable) => variable.private);
}

function privateVariableEntry(environment: string, variables: Collection['variables']) {
  const names = (variables ?? [])
    .filter((variable) => variable.private)
    .map((variable) => variable.key);
  return names.length > 0 ? { environment, names } : undefined;
}

export function downloadText(content: string, filename: string, mimeType = 'text/plain'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
