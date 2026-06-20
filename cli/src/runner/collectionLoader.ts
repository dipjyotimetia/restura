import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import {
  fileCollectionMetaSchema,
  fileHttpRequestSchema,
  fileGrpcRequestSchema,
  fileSseRequestSchema,
  fileMcpRequestSchema,
  getRequestTypeFromFilename,
} from '@/lib/shared/file-collection-schema';
import { loadCollectionFromFile, loadCollectionFromDir } from '@/lib/opencollection/fs-reader';
import { ocToInternal } from '@/lib/opencollection/to-internal';
import { resolveEffectiveAuth, isConfiguredAuth } from '@/features/auth/lib/authInheritance';
import type {
  HttpRequest,
  GrpcRequest,
  SseRequest,
  McpRequest,
  AuthConfig,
  Collection,
  CollectionItem,
} from '@/types';

export interface LoadedRequest {
  /** Absolute path to the source file when loaded from a directory layout. */
  filePath?: string;
  /** A friendly identifier for reporting — folder path + name (or legacy file path). */
  relativePath: string;
  /** Names of the folders this request lives under, top-down. Empty array = root. */
  folderPath: string[];
  type: 'http' | 'grpc' | 'sse' | 'mcp';
  request: HttpRequest | GrpcRequest | SseRequest | McpRequest;
}

export type CollectionFormat = 'opencollection-file' | 'opencollection-dir' | 'legacy-dir';

export interface LoadedCollection {
  meta: {
    name: string;
    description?: string;
    variables?: Array<{ key: string; value: string; enabled?: boolean }>;
  };
  requests: LoadedRequest[];
  /** Format detected at load time — used for deprecation warnings and reporters. */
  format: CollectionFormat;
}

/**
 * Load a Restura collection from disk. Auto-detects the on-disk format:
 *
 * 1. **OpenCollection bundled** — single `.yaml`/`.yml` file with a top-level
 *    `opencollection: "1.0.0"` key. Loaded via `loadCollectionFromFile`.
 * 2. **OpenCollection directory** — directory containing `opencollection.yml`
 *    (or `.yaml`) and per-request `*.yaml` files / folder subdirectories.
 *    Loaded via `loadCollectionFromDir`.
 * 3. **Legacy file-collection** — directory containing `_collection.yaml`
 *    plus `*.{http,grpc,sse,mcp}.yaml` files. This format is deprecated; a
 *    warning is emitted via stderr the first time it is seen in a run.
 *
 * All formats normalise to the same `LoadedRequest[]` shape so the runner
 * does not need to care which one produced the data.
 */
export async function loadCollection(target: string): Promise<LoadedCollection> {
  const info = await stat(target);

  if (info.isFile()) {
    const ext = extname(target).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') {
      throw new Error(`Unsupported collection file extension: ${target}. Expected .yaml or .yml.`);
    }
    return loadOpenCollectionFile(target);
  }

  if (!info.isDirectory()) {
    throw new Error(`Collection target is neither a file nor a directory: ${target}`);
  }

  const ocRoot = await findExisting(target, ['opencollection.yml', 'opencollection.yaml']);
  if (ocRoot) return loadOpenCollectionDir(target);

  const legacyRoot = await findExisting(target, ['_collection.yaml']);
  if (legacyRoot) {
    warnLegacyOnce();
    return loadLegacyFileCollection(target);
  }

  throw new Error(
    `No recognised collection layout at ${target}. Expected one of:\n` +
      `  - <dir>/opencollection.yml (OpenCollection directory layout)\n` +
      `  - <dir>/_collection.yaml (legacy Restura file-collection, deprecated)\n` +
      `  - a single .yaml/.yml file (bundled OpenCollection)`
  );
}

// ---------------------------------------------------------------------------
// OpenCollection paths
// ---------------------------------------------------------------------------

async function loadOpenCollectionFile(path: string): Promise<LoadedCollection> {
  const oc = await loadCollectionFromFile(path);
  const internal = ocToInternal(oc);
  return {
    meta: extractMeta(internal),
    requests: flattenInternal(internal),
    format: 'opencollection-file',
  };
}

async function loadOpenCollectionDir(dir: string): Promise<LoadedCollection> {
  const oc = await loadCollectionFromDir(dir);
  const internal = ocToInternal(oc);
  return {
    meta: extractMeta(internal),
    requests: flattenInternal(internal),
    format: 'opencollection-dir',
  };
}

function extractMeta(c: Collection): LoadedCollection['meta'] {
  const out: LoadedCollection['meta'] = { name: c.name };
  if (c.description) out.description = c.description;
  if (c.variables && c.variables.length > 0) {
    out.variables = c.variables.map((v) => {
      const item: { key: string; value: string; enabled?: boolean } = {
        key: v.key,
        value: v.value,
      };
      if (v.enabled !== undefined) item.enabled = v.enabled;
      return item;
    });
  }
  return out;
}

function flattenInternal(c: Collection): LoadedRequest[] {
  const out: LoadedRequest[] = [];
  // Seed inheritance from the collection root: collection-level scripts run
  // against every descendant; collection-level auth is the fallback when a
  // request (and every ancestor folder) leaves auth unconfigured. This mirrors
  // the desktop runner's `flattenRunnables` + `withEffectiveAuth`.
  walkItems(
    c.items ?? [],
    [],
    [c.preRequestScript],
    [c.testScript],
    isConfiguredAuth(c.auth) ? c.auth : undefined,
    out
  );
  return out;
}

/** Join non-empty script fragments in order; undefined when nothing applies. */
function combineScripts(parts: Array<string | undefined>): string | undefined {
  const nonEmpty = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return nonEmpty.length > 0 ? nonEmpty.join('\n') : undefined;
}

function walkItems(
  items: CollectionItem[],
  folderPath: string[],
  inheritedPre: Array<string | undefined>,
  inheritedTest: Array<string | undefined>,
  inheritedAuth: AuthConfig | undefined,
  out: LoadedRequest[]
): void {
  for (const item of items) {
    if (item.type === 'folder') {
      // Thread this folder's default scripts (parent→child order) and its
      // default auth (nearest-ancestor-wins) down to its descendants.
      walkItems(
        item.items ?? [],
        [...folderPath, item.name],
        [...inheritedPre, item.preRequestScript],
        [...inheritedTest, item.testScript],
        isConfiguredAuth(item.auth) ? item.auth : inheritedAuth,
        out
      );
      continue;
    }
    const req = item.request;
    if (!req) continue;
    const t = req.type;
    if (t !== 'http' && t !== 'grpc' && t !== 'sse' && t !== 'mcp') {
      // GraphQL/WebSocket are not in the internal Request union; ocToInternal
      // already converted GraphQL → http-body=graphql and surfaced WebSocket
      // as a folder, so anything else here is genuinely unrunnable.
      continue;
    }
    // Bake effective auth + combined scripts into the request so the executor
    // and runner can stay tree-shape-agnostic — the request's own auth/scripts
    // win, with collection/folder defaults filled in behind them.
    const pre = combineScripts([...inheritedPre, req.preRequestScript]);
    const test = combineScripts([...inheritedTest, req.testScript]);
    const effective = {
      ...req,
      auth: resolveEffectiveAuth(req.auth, inheritedAuth),
      ...(pre !== undefined ? { preRequestScript: pre } : {}),
      ...(test !== undefined ? { testScript: test } : {}),
    } as HttpRequest | GrpcRequest | SseRequest | McpRequest;
    out.push({
      relativePath: [...folderPath, item.name].join('/') || item.name,
      folderPath,
      type: t,
      request: effective,
    });
  }
}

// ---------------------------------------------------------------------------
// Legacy file-collection path (Restura's pre-OpenCollection on-disk layout)
// ---------------------------------------------------------------------------

let legacyWarned = false;
function warnLegacyOnce(): void {
  if (legacyWarned) return;
  legacyWarned = true;
  process.stderr.write(
    '[restura] DEPRECATION: loading the legacy `_collection.yaml` layout. ' +
      'Re-export this collection from the Restura app to get the OpenCollection ' +
      'directory format (`opencollection.yml`). Legacy support will be removed in a future release.\n'
  );
}

async function loadLegacyFileCollection(directoryPath: string): Promise<LoadedCollection> {
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
    const parent =
      (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
      (entry as unknown as { path?: string }).path ??
      directoryPath;
    const fullPath = join(parent, entry.name);
    const text = await readFile(fullPath, 'utf-8');
    const raw = yaml.load(text) as unknown;
    const request = parseLegacyRequest(type, raw);
    const rel = relative(directoryPath, fullPath);
    const segments = rel.split(/[/\\]/);
    const folderPath = segments.slice(0, -1);
    requests.push({
      filePath: fullPath,
      relativePath: rel,
      folderPath,
      type,
      request,
    });
  }

  // Stable ordering — readdir order is filesystem-dependent.
  requests.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const outMeta: LoadedCollection['meta'] = { name: meta.name };
  if (meta.description !== undefined) outMeta.description = meta.description;
  if (meta.variables) {
    outMeta.variables = meta.variables.map((v) => {
      const item: { key: string; value: string; enabled?: boolean } = {
        key: v.key,
        value: v.value,
      };
      if (v.enabled !== undefined) item.enabled = v.enabled;
      return item;
    });
  }

  return { meta: outMeta, requests, format: 'legacy-dir' };
}

function parseLegacyRequest(
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

async function findExisting(dir: string, candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    const p = join(dir, c);
    try {
      await stat(p);
      return p;
    } catch {
      // not present
    }
  }
  return null;
}
