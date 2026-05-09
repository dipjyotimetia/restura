import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import {
  fileCollectionMetaSchema,
  fileHttpRequestSchema,
  fileGrpcRequestSchema,
  fileSseRequestSchema,
  fileMcpRequestSchema,
  type FileCollectionMeta,
  getRequestTypeFromFilename,
} from '@/lib/shared/file-collection-schema';
import type {
  HttpRequest,
  GrpcRequest,
  SseRequest,
  McpRequest,
} from '@/types';

export interface LoadedRequest {
  /** Absolute path to the request file */
  filePath: string;
  /** Path relative to the collection root */
  relativePath: string;
  type: 'http' | 'grpc' | 'sse' | 'mcp';
  request: HttpRequest | GrpcRequest | SseRequest | McpRequest;
}

export interface LoadedCollection {
  meta: FileCollectionMeta;
  requests: LoadedRequest[];
}

/**
 * Load a Restura file-collection from disk.
 *
 * Reads `_collection.yaml` for metadata, then walks the directory recursively
 * for `*.{http,grpc,sse,mcp}.yaml` files. Each file is parsed via the shared
 * `file-collection-schema` and returned alongside its path information.
 */
export async function loadCollection(directoryPath: string): Promise<LoadedCollection> {
  const metaPath = join(directoryPath, '_collection.yaml');
  const metaText = await readFile(metaPath, 'utf-8');
  const metaRaw = yaml.load(metaText) as unknown;
  const meta = fileCollectionMetaSchema.parse(metaRaw);

  const requests: LoadedRequest[] = [];
  const entries = await readdir(directoryPath, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const type = getRequestTypeFromFilename(entry.name);
    if (!type) continue;
    // entry.parentPath is the absolute parent directory in Node 20+
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath
      ?? (entry as unknown as { path?: string }).path
      ?? directoryPath;
    const fullPath = join(parent, entry.name);
    const text = await readFile(fullPath, 'utf-8');
    const raw = yaml.load(text) as unknown;
    const request = parseRequest(type, raw);
    requests.push({
      filePath: fullPath,
      relativePath: relative(directoryPath, fullPath),
      type,
      request,
    });
  }

  // Stable ordering — readdir order is filesystem-dependent.
  requests.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return { meta, requests };
}

function parseRequest(
  type: 'http' | 'grpc' | 'sse' | 'mcp',
  raw: unknown
): HttpRequest | GrpcRequest | SseRequest | McpRequest {
  switch (type) {
    case 'http': {
      const parsed = fileHttpRequestSchema.parse(raw);
      const out: HttpRequest = {
        id: uuidv4(),
        name: parsed.name,
        type: 'http',
        method: parsed.method,
        url: parsed.url,
        headers: (parsed.headers ?? []).map((h) => ({
          id: uuidv4(),
          key: h.key,
          value: h.value,
          enabled: h.enabled,
          ...(h.description !== undefined ? { description: h.description } : {}),
        })),
        params: (parsed.params ?? []).map((p) => ({
          id: uuidv4(),
          key: p.key,
          value: p.value,
          enabled: p.enabled,
          ...(p.description !== undefined ? { description: p.description } : {}),
        })),
        body: (parsed.body as HttpRequest['body']) ?? { type: 'none' },
        auth: (parsed.auth as HttpRequest['auth']) ?? { type: 'none' },
      };
      if (parsed.preRequestScript !== undefined) out.preRequestScript = parsed.preRequestScript;
      if (parsed.testScript !== undefined) out.testScript = parsed.testScript;
      if (parsed.settings) out.settings = parsed.settings;
      return out;
    }
    case 'grpc': {
      const parsed = fileGrpcRequestSchema.parse(raw);
      const out: GrpcRequest = {
        id: uuidv4(),
        name: parsed.name,
        type: 'grpc',
        methodType: parsed.methodType,
        url: parsed.url,
        service: parsed.service,
        method: parsed.method,
        metadata: (parsed.metadata ?? []).map((m) => ({
          id: uuidv4(),
          key: m.key,
          value: m.value,
          enabled: m.enabled,
          ...(m.description !== undefined ? { description: m.description } : {}),
        })),
        message: parsed.message ?? '',
        auth: (parsed.auth as GrpcRequest['auth']) ?? { type: 'none' },
      };
      if (parsed.preRequestScript !== undefined) out.preRequestScript = parsed.preRequestScript;
      if (parsed.testScript !== undefined) out.testScript = parsed.testScript;
      return out;
    }
    case 'sse': {
      const parsed = fileSseRequestSchema.parse(raw);
      const out: SseRequest = {
        id: uuidv4(),
        name: parsed.name,
        type: 'sse',
        url: parsed.url,
        headers: (parsed.headers ?? []).map((h) => ({
          id: uuidv4(),
          key: h.key,
          value: h.value,
          enabled: h.enabled,
          ...(h.description !== undefined ? { description: h.description } : {}),
        })),
        params: (parsed.params ?? []).map((p) => ({
          id: uuidv4(),
          key: p.key,
          value: p.value,
          enabled: p.enabled,
          ...(p.description !== undefined ? { description: p.description } : {}),
        })),
        auth: (parsed.auth as SseRequest['auth']) ?? { type: 'none' },
      };
      if (parsed.eventFilter) out.eventFilter = parsed.eventFilter;
      if (parsed.reconnectOnResume !== undefined) out.reconnectOnResume = parsed.reconnectOnResume;
      if (parsed.preRequestScript !== undefined) out.preRequestScript = parsed.preRequestScript;
      if (parsed.testScript !== undefined) out.testScript = parsed.testScript;
      return out;
    }
    case 'mcp': {
      const parsed = fileMcpRequestSchema.parse(raw);
      const out: McpRequest = {
        id: uuidv4(),
        name: parsed.name,
        type: 'mcp',
        url: parsed.url,
        transport: parsed.transport,
        headers: (parsed.headers ?? []).map((h) => ({
          id: uuidv4(),
          key: h.key,
          value: h.value,
          enabled: h.enabled,
          ...(h.description !== undefined ? { description: h.description } : {}),
        })),
        auth: (parsed.auth as McpRequest['auth']) ?? { type: 'none' },
      };
      if (parsed.defaultMethod) out.defaultMethod = parsed.defaultMethod;
      if (parsed.defaultParams) out.defaultParams = parsed.defaultParams;
      if (parsed.preRequestScript !== undefined) out.preRequestScript = parsed.preRequestScript;
      if (parsed.testScript !== undefined) out.testScript = parsed.testScript;
      return out;
    }
  }
}
