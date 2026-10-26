import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { isConfiguredAuth, resolveEffectiveAuth } from '@shared/auth/inheritance';
import {
  fileCollectionMetaSchema,
  fileGrpcRequestSchema,
  fileHttpRequestSchema,
  fileMcpRequestSchema,
  fileSseRequestSchema,
  getRequestTypeFromFilename,
} from '@shared/collections/legacy-file-schema';
import { getPostmanSidecar, POSTMAN_V3_LIMITS } from '@shared/collections/postman';
import {
  loadCollectionFromDir,
  loadCollectionFromFile,
} from '@shared/opencollection/node/fs-reader';
import { ocToInternal } from '@shared/opencollection/to-internal';
import { resolveMcpEffectiveAuth } from '@shared/protocol/mcp-auth';
import type {
  AuthConfig,
  Collection,
  CollectionItem,
  GrpcRequest,
  HttpRequest,
  McpRequest,
  SseRequest,
} from '@shared/types';
import * as yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import {
  type CliPostmanImportReport,
  importPostmanDocument,
  importPostmanFolder,
  importPostmanZip,
  isPostmanDocument,
  type PostmanLimits,
  readCappedFile,
} from './postmanImport.js';

export interface LoadedRequest {
  /** Absolute path to the source file when loaded from a directory layout. */
  filePath?: string;
  /** A friendly identifier for reporting — folder path + name (or legacy file path). */
  relativePath: string;
  /** Names of the folders this request lives under, top-down. Empty array = root. */
  folderPath: string[];
  type: 'http' | 'grpc' | 'sse' | 'mcp';
  request: HttpRequest | GrpcRequest | SseRequest | McpRequest;
  /**
   * Set when the request must NOT be sent; the runner reports it as a failed
   * ("not sent") result with this reason instead of executing it. Used for
   * Postman requests whose auth type Restura cannot sign (imported as `none`),
   * so they never go out unauthenticated or with a fallback credential.
   */
  blocked?: string;
}

export type CollectionFormat =
  | 'opencollection-file'
  | 'opencollection-dir'
  | 'legacy-dir'
  | 'postman-v2'
  | 'postman-v3';

export interface LoadCollectionOptions {
  /** Override the shared Postman v3 caps (tests; defaults: `POSTMAN_V3_LIMITS`). */
  postmanLimits?: PostmanLimits;
}

export interface LoadedCollection {
  meta: {
    name: string;
    description?: string;
    variables?: Array<{ key: string; value: string; enabled?: boolean }>;
    privateVariableNames?: string[];
  };
  requests: LoadedRequest[];
  /** Format detected at load time — used for deprecation warnings and reporters. */
  format: CollectionFormat;
  /** Postman inputs only: the shared import report (what was dropped / approximated). */
  importReport?: CliPostmanImportReport;
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
export async function loadCollection(
  target: string,
  options: LoadCollectionOptions = {}
): Promise<LoadedCollection> {
  const info = await stat(target);
  const limits = options.postmanLimits ?? {};

  if (info.isFile()) {
    const ext = extname(target).toLowerCase();
    if (ext === '.zip') {
      const { collection, report } = await importPostmanZip(target, limits);
      return fromPostman(collection, report);
    }
    if (ext === '.json') {
      const text = (await readCappedFile(target, singleFileCap(limits), 'the file')).toString(
        'utf8'
      );
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${target} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!isPostmanDocument(data)) {
        throw new Error(
          `${target} is not a Postman collection (expected info.schema / info._postman_id for v2.x, or $kind: "collection" for v3).`
        );
      }
      const { collection, report } = importPostmanDocument(data, limits);
      return fromPostman(collection, report);
    }
    if (ext !== '.yaml' && ext !== '.yml') {
      throw new Error(
        `Unsupported collection file extension: ${target}. Expected .yaml / .yml (OpenCollection or Postman v3), .json (Postman v2.x / v3) or .zip (Postman v3).`
      );
    }
    const text = (await readCappedFile(target, singleFileCap(limits), 'the file')).toString('utf8');
    const doc = safeYaml(text);
    if (isPostmanDocument(doc)) {
      const { collection, report } = importPostmanDocument(doc, limits);
      return fromPostman(collection, report);
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

  const postman = await importPostmanFolder(target, limits);
  if (postman) return fromPostman(postman.collection, postman.report);

  throw new Error(
    `No recognised collection layout at ${target}. Expected one of:\n` +
      `  - <dir>/opencollection.yml (OpenCollection directory layout)\n` +
      `  - <dir>/_collection.yaml (legacy Restura file-collection, deprecated)\n` +
      `  - a Postman v3 folder (*.request.yaml / .resources/definition.yaml)\n` +
      `  - a single .yaml/.yml file (bundled OpenCollection or Postman v3)\n` +
      `  - a Postman .json (v2.0 / v2.1 / v3) or v3 .zip file`
  );
}

// ---------------------------------------------------------------------------
// Postman paths (#1202) — the shared parser, then the same flattening as OC
// ---------------------------------------------------------------------------

/** A single Postman document may be a whole v2.1 export: allow the total-size cap. */
function singleFileCap(limits: PostmanLimits): number {
  return limits.maxTotalBytes ?? POSTMAN_V3_LIMITS.maxTotalBytes;
}

/** Sniff-only YAML parse (safe default schema); a parse error falls through to the OC loader. */
function safeYaml(text: string): unknown {
  try {
    return yaml.load(text);
  } catch {
    return undefined;
  }
}

function fromPostman(c: Collection, report: CliPostmanImportReport): LoadedCollection {
  const meta = extractMeta(c);
  // v3 vault secrets import value-less (`secret: true`). Never fold them in
  // as an empty value (that would also shadow an `--env` value): treat them as
  // private variables, so a request that uses one without a value fails
  // explicitly (`assertCliSecretsAvailable`), the same rule as OC private vars.
  const secretNames = collectSecretVariableNames(c);
  if (secretNames.size > 0) {
    if (meta.variables) {
      meta.variables = meta.variables.filter((v) => !secretNames.has(v.key));
      if (meta.variables.length === 0) delete meta.variables;
    }
    meta.privateVariableNames = [
      ...new Set([...(meta.privateVariableNames ?? []), ...secretNames]),
    ];
  }
  return {
    meta,
    requests: flattenInternal(c),
    format: report.sourceVersion === '3.0' ? 'postman-v3' : 'postman-v2',
    importReport: report,
  };
}

type MaybeSecretVar = { key: string; secret?: boolean };

function collectSecretVariableNames(c: Collection): Set<string> {
  const out = new Set<string>();
  const add = (vars: readonly MaybeSecretVar[] | undefined) => {
    for (const v of vars ?? []) if (v.secret === true && v.key) out.add(v.key);
  };
  add(c.variables as MaybeSecretVar[] | undefined);
  const walk = (items: CollectionItem[]) => {
    for (const item of items) {
      add((item as { variables?: MaybeSecretVar[] }).variables);
      if (item.type === 'folder') walk(item.items ?? []);
    }
  };
  walk(c.items ?? []);
  return out;
}

/**
 * Postman auth Restura cannot sign (hawk, edgegrid, jwt, akamai, …) imports
 * as `none` with the raw block in the `_postman` sidecar. Returns the Postman
 * auth type when `node` is such a case.
 */
function unsupportedPostmanAuth(node: object, auth: AuthConfig | undefined): string | undefined {
  const sidecar = getPostmanSidecar(node);
  if (!sidecar?.auth || sidecar.authBagOnly || isConfiguredAuth(auth)) return undefined;
  const type = (sidecar.auth as { type?: unknown }).type;
  return typeof type === 'string' && type !== '' ? type : 'unknown';
}

/**
 * Inheritance state for unsupported Postman auth. `ancestorAuths` are the
 * auth objects of the containers above the unsupported one: the parser bakes
 * an inherited auth into a request BY REFERENCE, so a request whose auth is one
 * of them inherited it past the unsupported container (a fallback credential
 * Postman would not have sent).
 */
interface AuthGuard {
  unsupported?: { type: string; owner: string };
  ancestorAuths: readonly AuthConfig[];
}

function nextGuard(
  guard: AuthGuard,
  node: object,
  auth: AuthConfig | undefined,
  name: string
): AuthGuard {
  const ancestorAuths = auth ? [...guard.ancestorAuths, auth] : guard.ancestorAuths;
  const type = unsupportedPostmanAuth(node, auth);
  if (type) return { unsupported: { type, owner: name }, ancestorAuths: guard.ancestorAuths };
  if (isConfiguredAuth(auth)) return { ancestorAuths };
  return { ...guard, ancestorAuths };
}

function blockedReason(
  item: object,
  req: { auth?: AuthConfig },
  guard: AuthGuard
): string | undefined {
  const reason = (type: string, from: string) =>
    `not sent: Postman auth type "${type}"${from} is not supported by Restura (imported as no auth); ` +
    'the CLI will not send it unauthenticated. Configure a supported auth or exclude the request.';
  const own = unsupportedPostmanAuth(item, req.auth);
  if (own) return reason(own, '');
  const up = guard.unsupported;
  if (!up) return undefined;
  if (!isConfiguredAuth(req.auth) || guard.ancestorAuths.includes(req.auth)) {
    return reason(up.type, ` (inherited from "${up.owner}")`);
  }
  return undefined;
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
  const privateVariables = (c as Collection & { _oc?: { extensions?: Record<string, unknown> } })
    ._oc?.extensions?.['x-restura-private-variables'];
  if (Array.isArray(privateVariables)) {
    out.privateVariableNames = privateVariables.flatMap((entry) => {
      const names = (entry as { names?: unknown }).names;
      return Array.isArray(names)
        ? names.filter((name): name is string => typeof name === 'string')
        : [];
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
    nextGuard({ ancestorAuths: [] }, c, c.auth, c.name),
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
  guard: AuthGuard,
  out: LoadedRequest[]
): void {
  for (const item of items) {
    if (item.type === 'folder') {
      const placeholder = getPostmanSidecar(item)?.item;
      if (placeholder !== undefined && (item.items ?? []).length === 0) {
        // A Postman v3 item kind with no Restura equivalent (WebSocket,
        // Socket.IO, LLM, data …) imports as an empty placeholder folder.
        reportSkippedPlaceholder([...folderPath, item.name].join('/'));
        continue;
      }
      // Thread this folder's default scripts (parent→child order) and its
      // default auth (nearest-ancestor-wins) down to its descendants.
      walkItems(
        item.items ?? [],
        [...folderPath, item.name],
        [...inheritedPre, item.preRequestScript],
        [...inheritedTest, item.testScript],
        isConfiguredAuth(item.auth) ? item.auth : inheritedAuth,
        nextGuard(guard, item, item.auth, [...folderPath, item.name].join('/')),
        out
      );
      continue;
    }
    const req = item.request;
    if (!req) continue;
    const t = req.type;
    if (t === 'kafka' || t === 'mqtt') {
      // Kafka / MQTT connection presets (#984) hold no runnable request — the
      // CLI has no broker transport. Report the skip instead of failing.
      reportSkippedPreset(t, [...folderPath, item.name].join('/'));
      continue;
    }
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
      // MCP skips an inherited scheme it can't carry (shared policy, #896) —
      // the same rule the app applies at connect time.
      auth:
        t === 'mcp'
          ? (resolveMcpEffectiveAuth(req.auth, inheritedAuth).auth ?? req.auth)
          : resolveEffectiveAuth(req.auth, inheritedAuth),
      ...(pre !== undefined ? { preRequestScript: pre } : {}),
      ...(test !== undefined ? { testScript: test } : {}),
    } as HttpRequest | GrpcRequest | SseRequest | McpRequest;
    const blocked = blockedReason(item, req, guard);
    out.push({
      relativePath: [...folderPath, item.name].join('/') || item.name,
      folderPath,
      type: t,
      request: effective,
      ...(blocked ? { blocked } : {}),
    });
  }
}

function reportSkippedPlaceholder(path: string): void {
  process.stderr.write(
    `[restura] skipping "${path}": this Postman item kind has no Restura equivalent yet ` +
      '(imported as an empty placeholder); it is not run by the CLI.\n'
  );
}

function reportSkippedPreset(type: 'kafka' | 'mqtt', path: string): void {
  const label = type === 'kafka' ? 'Kafka' : 'MQTT';
  process.stderr.write(
    `[restura] skipping ${label} preset "${path}": Kafka and MQTT connection presets ` +
      'open in the Restura desktop app and are not run by the CLI.\n'
  );
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
      if (parsed.stdio) {
        // Carried for fidelity only; the MCP executor refuses stdio.
        out.stdio = {
          command: parsed.stdio.command,
          args: parsed.stdio.args ?? [],
          ...(parsed.stdio.cwd !== undefined ? { cwd: parsed.stdio.cwd } : {}),
        };
      }
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
