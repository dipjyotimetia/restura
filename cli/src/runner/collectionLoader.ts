import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isConfiguredAuth, resolveEffectiveAuth } from '@shared/auth/inheritance';
import {
  fileCollectionMetaSchema,
  fileGrpcRequestSchema,
  fileHttpRequestSchema,
  fileMcpRequestSchema,
  fileSseRequestSchema,
  getRequestTypeFromFilename,
} from '@shared/collections/legacy-file-schema';
import { getPostmanSidecar } from '@shared/collections/postman';
import {
  loadCollectionFromDir,
  loadCollectionFromFile,
} from '@shared/opencollection/node/fs-reader';
import { ocToInternal } from '@shared/opencollection/to-internal';
import { resolveMcpEffectiveAuth } from '@shared/protocol/mcp-auth';
import { combineScripts } from '@shared/scripts/combine-scripts';
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
  importPostmanFolder,
  loadPostmanFile,
  nextPostmanAuthGuard,
  type PostmanAuthGuard,
  type PostmanLimits,
  postmanBlockedReason,
  postmanSecretVariableNames,
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
  /**
   * Enabled variables of the folders above this request, outer → inner
   * (inner wins). The runner layers them over env + collection vars and under
   * the iteration row, matching the app's collection runner.
   */
  folderVariables?: Record<string, string>;
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
    // Postman (.zip / .json / Postman-v3 YAML) first; other YAML is OpenCollection.
    const postman = await loadPostmanFile(target, limits);
    if (postman) return fromPostman(postman.collection, postman.report);
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

function fromPostman(c: Collection, report: CliPostmanImportReport): LoadedCollection {
  const meta = extractMeta(c);
  // Secret variables (v3 vault, v2.1 `type: "secret"`) import value-less
  // (`secret: true`). Never fold them in as an empty value (that would also
  // shadow an `--env` value): treat them as private variables, so a request that uses one without a value fails
  // explicitly (`assertCliSecretsAvailable`), the same rule as OC private vars.
  const secretNames = postmanSecretVariableNames(c);
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
    nextPostmanAuthGuard({}, c),
    {},
    out
  );
  return out;
}

function walkItems(
  items: CollectionItem[],
  folderPath: string[],
  inheritedPre: Array<string | undefined>,
  inheritedTest: Array<string | undefined>,
  inheritedAuth: AuthConfig | undefined,
  guard: PostmanAuthGuard,
  folderVars: Readonly<Record<string, string>>,
  out: LoadedRequest[]
): void {
  for (const item of items) {
    if (item.type === 'folder') {
      const placeholder = getPostmanSidecar(item)?.item;
      if (placeholder !== undefined && (item.items ?? []).length === 0) {
        // A Postman v3 item kind with no Restura equivalent (LLM, data,
        // MCP stdio …) imports as an empty placeholder folder. WebSocket /
        // Socket.IO import as native items since #1209 (skipped below);
        // only collections saved before that may still hold placeholders.
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
        nextPostmanAuthGuard(guard, item, [...folderPath, item.name].join('/')),
        // Folder variables, outer → inner (inner wins), as the app's runner
        // layers them (`flattenRunnables` + `buildValueMap({ folders })`).
        { ...folderVars, ...folderVariableValues(item.variables) },
        out
      );
      continue;
    }
    const req = item.request;
    if (!req) continue;
    const t = req.type;
    if (t === 'kafka' || t === 'mqtt' || t === 'websocket' || t === 'socketio') {
      // Connection presets — Kafka / MQTT (#984), WebSocket / Socket.IO (#1209) —
      // hold no runnable request; the app's runner skips them too. Report the
      // skip instead of failing.
      reportSkippedPreset(t, [...folderPath, item.name].join('/'));
      continue;
    }
    if (t !== 'http' && t !== 'grpc' && t !== 'sse' && t !== 'mcp') {
      // GraphQL is not in the internal Request union (ocToInternal converts
      // it to http with a graphql body) and the connection presets were
      // handled above, so anything else here is genuinely unrunnable.
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
      ...(t === 'http' ? { body: withEnabledFormRows((req as HttpRequest).body) } : {}),
      ...(pre !== undefined ? { preRequestScript: pre } : {}),
      ...(test !== undefined ? { testScript: test } : {}),
    } as HttpRequest | GrpcRequest | SseRequest | McpRequest;
    const blocked = postmanBlockedReason(item, guard);
    out.push({
      relativePath: [...folderPath, item.name].join('/') || item.name,
      folderPath,
      type: t,
      request: effective,
      ...(blocked ? { blocked } : {}),
      ...(Object.keys(folderVars).length > 0 ? { folderVariables: { ...folderVars } } : {}),
    });
  }
}

/**
 * The send rule for form rows is a truthy `enabled`, but neither on-disk format
 * guarantees the flag: OpenCollection parts and legacy `formData` are carried
 * through as written. A row saved without one has always been sent by the CLI, so
 * it means enabled. Normalised at load so every CLI entry point (runner, OWS
 * workflows, agent tools) sees the same rows.
 */
function withEnabledFormRows(body: HttpRequest['body']): HttpRequest['body'] {
  if (!body?.formData) return body;
  return {
    ...body,
    formData: body.formData.map((row) =>
      row.enabled === undefined ? { ...row, enabled: true } : row
    ),
  };
}

/**
 * Enabled folder variables as a value map. Secret (value-less Postman vault),
 * private and handle-backed variables are left out: the CLI cannot resolve
 * them, and an empty value must never shadow a provided one.
 */
function folderVariableValues(
  vars: ReadonlyArray<{ key: string; value: string; enabled?: boolean }> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars ?? []) {
    const flags = v as { secret?: unknown; private?: unknown; secretRef?: unknown };
    if (!v.key || v.enabled === false) continue;
    if (flags.secret === true || flags.private === true || flags.secretRef !== undefined) continue;
    out[v.key] = v.value;
  }
  return out;
}

function reportSkippedPlaceholder(path: string): void {
  process.stderr.write(
    `[restura] skipping "${path}": this Postman item kind has no Restura equivalent yet ` +
      '(imported as an empty placeholder); it is not run by the CLI.\n'
  );
}

const PRESET_LABEL = {
  kafka: 'Kafka',
  mqtt: 'MQTT',
  websocket: 'WebSocket',
  socketio: 'Socket.IO',
} as const;

function reportSkippedPreset(type: keyof typeof PRESET_LABEL, path: string): void {
  const label = PRESET_LABEL[type];
  const where =
    type === 'kafka' || type === 'mqtt'
      ? 'Kafka and MQTT connection presets open in the Restura desktop app'
      : 'WebSocket and Socket.IO connections open in the Restura app';
  process.stderr.write(
    `[restura] skipping ${label} preset "${path}": ${where} and are not run by the CLI.\n`
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
        body: withEnabledFormRows((parsed.body as HttpRequest['body']) ?? { type: 'none' }),
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
      if (parsed.autoReconnect !== undefined) out.autoReconnect = parsed.autoReconnect;
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
