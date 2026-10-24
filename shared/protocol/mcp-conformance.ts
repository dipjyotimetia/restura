/**
 * MCP era/conformance engine (#911). Pure and backend-agnostic: it drives an
 * injected `McpConformanceSession` factory through a scripted sequence per
 * protocol era (legacy `initialize` era and modern 2026-07-28 era), collects
 * spec violations, and returns a JSON-safe report. Desktop feeds it SDK clients
 * (one per era), web feeds it a single legacy-era client over `/api/mcp`, and
 * the CLI feeds it a fetch-based client. Cross-era diff + Markdown live in
 * `mcp-conformance-report.ts`.
 *
 * Safety: sample `tools/call` invocations are opt-in. Destructive tools
 * (`destructiveHint: true`) are never invoked; tools that are not
 * `readOnlyHint: true` are only invoked when the caller names them in
 * `approvedTools`. Annotations are untrusted hints, so this is a speed bump
 * for honest servers, not a security boundary. Call payloads are never stored
 * in the report (only status/timings/violations).
 */
import type { McpToolDescriptor } from '../types/streaming';
import { computeMcpEraDiff, type McpEraDiff } from './mcp-conformance-report';
import { runSamples, snapshotTool, synthesizeSample } from './mcp-conformance-samples';
import { clipText, hashJson, MAX_ERROR_TEXT, sanitizeText } from './mcp-conformance-text';
import { normalizeMcpToolDescriptor } from './mcp-tool-descriptor';

export type McpEra = 'legacy' | 'modern';
export type McpFindingSeverity = 'error' | 'warning' | 'info';

export interface McpConformanceFinding {
  /** Stable machine id, e.g. `tools.output-schema-mismatch`. */
  code: string;
  severity: McpFindingSeverity;
  era: McpEra | 'cross-era';
  message: string;
  /** Tool / resource / prompt the finding is about, when applicable. */
  subject?: string;
}

/** One connected, already-negotiated session for a single era. */
export interface McpConformanceSession {
  protocolVersion: string;
  serverCapabilities: unknown;
  serverInfo: unknown;
  /** Rejects on any failure; JSON-RPC errors should carry a numeric `code`. */
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpConformanceDeps {
  /** Open a session pinned to `era`; reject when the server doesn't speak it. */
  open(era: McpEra): Promise<McpConformanceSession>;
  now?: () => number;
}

export type McpSampleCallMode = 'off' | 'read-only' | 'selected';

export interface McpConformanceOptions {
  eras?: McpEra[];
  /** `read-only` calls readOnlyHint tools; `selected` also calls `approvedTools`. */
  sampleCalls?: McpSampleCallMode;
  /** Non-read-only tool names the user explicitly approved. Never overrides destructive. */
  approvedTools?: string[];
  /** Hard cap on pagination iterations per list. */
  maxPages?: number;
  /** Target label for the report; credentials/query are stripped. */
  target?: string;
  /** Caller-supplied secrets (e.g. header values); exact occurrences (>= 8 chars) are scrubbed from the report. */
  secrets?: string[];
  /** Total-run abort (deadline / cancel): in-flight and later requests reject once aborted. */
  signal?: AbortSignal;
}

export interface McpSampleCallRecord {
  tool: string;
  status: 'ok' | 'tool-error' | 'protocol-error' | 'skipped';
  reason?: string;
  durationMs?: number;
  outputSchema?: 'valid' | 'invalid' | 'missing' | 'no-schema' | 'skipped';
}

/**
 * Report-side listing entry. Full descriptor bodies (schemas, descriptions) are
 * server-controlled and unbounded, so the report keeps only the name plus a
 * content hash per field; the cross-era diff compares hashes.
 */
export interface McpDescriptorSnapshot {
  name: string;
  title?: string;
  fields: Record<string, string>;
}

export interface McpListingSnapshot {
  tools: McpDescriptorSnapshot[];
  resources: Array<{ uri: string; name?: string; mimeType?: string }>;
  prompts: McpDescriptorSnapshot[];
}

export interface McpEraResult {
  era: McpEra;
  /** `unsupported` = server doesn't speak this era (not by itself a violation of the other). */
  status: 'ok' | 'unsupported' | 'failed';
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string; title?: string };
  capabilities?: Record<string, unknown>;
  error?: string;
  listing: McpListingSnapshot;
  samples: McpSampleCallRecord[];
  findings: McpConformanceFinding[];
  durationMs: number;
}

export interface McpConformanceReport {
  schemaVersion: 1;
  generatedAt: string;
  target: string;
  options: { sampleCalls: McpSampleCallMode; approvedTools: string[] };
  eras: McpEraResult[];
  /** Legacy-vs-modern diff; null unless both eras connected. */
  diff: McpEraDiff | null;
  /** Per-era findings plus cross-era diff findings. */
  findings: McpConformanceFinding[];
  summary: { errors: number; warnings: number; info: number };
}

const DEFAULT_MAX_PAGES = 50;
const MAX_LIST_ITEMS = 1000;
const MAX_FINDINGS = 500;
export const MCP_MODERN_ERA_FLOOR = '2026-07-28';
const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

type Add = (severity: McpFindingSeverity, code: string, message: string, subject?: string) => void;

/** Connection problems that say nothing about protocol-era support. */
function isNonNegotiationFailure(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const text = `${errMessage(err)} ${
    err instanceof Error && err.cause ? errMessage(err.cause) : ''
  }`;
  return /time(d)? ?out|abort|ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT|fetch failed|network|socket|refused|\b(401|403|407|429)\b|unauthori[sz]ed|forbidden|certificate/i.test(
    text
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/** Strip credentials, query and fragment: reports are shareable. */
export function redactConformanceTarget(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '(invalid url)';
  }
}

/**
 * Make every request on `session` reject once `signal` aborts (total-run
 * deadline), including requests already in flight.
 */
function guardSession(
  session: McpConformanceSession,
  signal: AbortSignal | undefined
): McpConformanceSession {
  if (!signal) return session;
  const aborted = () => new Error('Conformance run aborted (deadline reached)');
  return {
    protocolVersion: session.protocolVersion,
    serverCapabilities: session.serverCapabilities,
    serverInfo: session.serverInfo,
    close: () => session.close(),
    request(method, params) {
      if (signal.aborted) return Promise.reject(aborted());
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(aborted());
        signal.addEventListener('abort', onAbort, { once: true });
        session.request(method, params).then(
          (v) => {
            signal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (e) => {
            signal.removeEventListener('abort', onAbort);
            reject(e);
          }
        );
      });
    },
  };
}

/** Depth/width/length-bounded, sanitized copy of a server-provided JSON value. */
function boundValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') return sanitizeText(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => boundValue(v, secrets, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([k, v]) => [sanitizeText(k, secrets, 100), boundValue(v, secrets, depth + 1)])
    );
  }
  return null;
}

// ---------- capabilities ----------

const CAP_OBJECT_KEYS = ['tools', 'resources', 'prompts', 'logging', 'completions', 'experimental'];

function checkCapabilities(raw: unknown, add: Add): Record<string, unknown> | undefined {
  if (!isRecord(raw)) {
    add('error', 'capabilities.missing', 'Server did not return a capabilities object');
    return undefined;
  }
  for (const key of CAP_OBJECT_KEYS) {
    if (key in raw && !isRecord(raw[key])) {
      add('error', 'capabilities.malformed', `capabilities.${key} must be an object`, key);
    }
  }
  const boolFlag = (group: string, flag: string) => {
    const g = raw[group];
    if (isRecord(g) && flag in g && typeof g[flag] !== 'boolean') {
      add(
        'error',
        'capabilities.malformed',
        `capabilities.${group}.${flag} must be a boolean`,
        group
      );
    }
  };
  boolFlag('tools', 'listChanged');
  boolFlag('prompts', 'listChanged');
  boolFlag('resources', 'listChanged');
  boolFlag('resources', 'subscribe');
  return raw;
}

// ---------- listing with pagination ----------

async function listAll(
  session: McpConformanceSession,
  method: string,
  key: 'tools' | 'resources' | 'prompts',
  maxPages: number,
  add: Add
): Promise<unknown[] | undefined> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let res: unknown;
    try {
      res = await session.request(method, cursor !== undefined ? { cursor } : undefined);
    } catch (err) {
      add('error', 'list.failed', `${method} failed: ${errMessage(err)}`, method);
      return page === 0 ? undefined : items;
    }
    if (!isRecord(res)) {
      add('error', 'list.malformed', `${method} result must be an object`, method);
      return items;
    }
    const arr = res[key];
    if (!Array.isArray(arr)) {
      add('error', 'list.malformed', `${method} result is missing the "${key}" array`, method);
      return items;
    }
    // Never spread a server-controlled array into push(): a huge page throws RangeError.
    const room = MAX_LIST_ITEMS - items.length;
    for (let i = 0; i < arr.length && i < room; i++) items.push(arr[i]);
    if (items.length >= MAX_LIST_ITEMS) {
      if (arr.length > room || res.nextCursor) {
        add(
          'warning',
          'list.truncated',
          `${method} returned more than ${MAX_LIST_ITEMS} items; the rest were not checked`,
          method
        );
      }
      return items;
    }
    const next = res.nextCursor;
    if (next === undefined || next === null) return items;
    if (typeof next !== 'string' || next === '') {
      add(
        'error',
        'pagination.bad-cursor',
        `${method} returned a non-string or empty nextCursor`,
        method
      );
      return items;
    }
    if (seen.has(next) || next === cursor) {
      add(
        'error',
        'pagination.cursor-loop',
        `${method} returned a repeated nextCursor (${next})`,
        method
      );
      return items;
    }
    seen.add(next);
    cursor = next;
  }
  add(
    'warning',
    'pagination.page-cap',
    `${method} still paginating after ${maxPages} pages; stopped`,
    method
  );
  return items;
}

// ---------- descriptor checks ----------

function checkTools(raw: unknown[], add: Add): McpToolDescriptor[] {
  const out: McpToolDescriptor[] = [];
  const names = new Set<string>();
  for (const entry of raw) {
    const norm = normalizeMcpToolDescriptor(entry);
    const rec = isRecord(entry) ? entry : {};
    const label = typeof rec.name === 'string' && rec.name ? rec.name : '(unnamed)';
    if (!norm) {
      add(
        'error',
        'tools.descriptor-invalid',
        'Tool descriptor failed normalization (needs a non-empty string name)',
        label
      );
      continue;
    }
    if (names.has(norm.name)) {
      add('error', 'tools.duplicate-name', `Duplicate tool name "${norm.name}"`, norm.name);
    }
    names.add(norm.name);
    if (!isRecord(rec.inputSchema)) {
      add(
        'error',
        'tools.input-schema-missing',
        'Tool must declare an inputSchema object',
        norm.name
      );
    } else if (rec.inputSchema.type !== 'object') {
      add('warning', 'tools.input-schema-type', 'inputSchema.type should be "object"', norm.name);
    }
    if ('outputSchema' in rec) {
      if (!isRecord(rec.outputSchema)) {
        add(
          'error',
          'tools.output-schema-malformed',
          'outputSchema must be a JSON Schema object',
          norm.name
        );
      } else if (rec.outputSchema.type !== 'object') {
        add(
          'warning',
          'tools.output-schema-type',
          'outputSchema.type should be "object"',
          norm.name
        );
      }
    }
    if ('annotations' in rec) {
      const a = rec.annotations;
      if (!isRecord(a)) {
        add('warning', 'tools.annotations-malformed', 'annotations must be an object', norm.name);
      } else {
        for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
          if (k in a && typeof a[k] !== 'boolean') {
            add(
              'warning',
              'tools.annotations-malformed',
              `annotations.${k} must be a boolean (dropped)`,
              norm.name
            );
          }
        }
      }
    }
    if (norm.description === undefined) {
      add('info', 'tools.no-description', 'Tool has no description', norm.name);
    }
    out.push(norm);
  }
  return out;
}

function checkResources(raw: unknown[], add: Add): McpListingSnapshot['resources'] {
  const out: McpListingSnapshot['resources'] = [];
  const uris = new Set<string>();
  for (const entry of raw) {
    const r = isRecord(entry) ? entry : {};
    if (typeof r.uri !== 'string' || r.uri === '') {
      add(
        'error',
        'resources.descriptor-invalid',
        'Resource needs a non-empty string uri',
        typeof r.name === 'string' ? r.name : undefined
      );
      continue;
    }
    if (typeof r.name !== 'string' || r.name === '') {
      add('error', 'resources.name-missing', 'Resource needs a name', r.uri);
    }
    if (uris.has(r.uri)) {
      add('error', 'resources.duplicate-uri', `Duplicate resource uri "${r.uri}"`, r.uri);
    }
    uris.add(r.uri);
    out.push({
      uri: clipText(r.uri),
      ...(typeof r.name === 'string' ? { name: clipText(r.name) } : {}),
      ...(typeof r.mimeType === 'string' ? { mimeType: clipText(r.mimeType, 100) } : {}),
    });
  }
  return out;
}

function checkPrompts(raw: unknown[], add: Add): McpDescriptorSnapshot[] {
  const out: McpDescriptorSnapshot[] = [];
  const names = new Set<string>();
  for (const entry of raw) {
    const p = isRecord(entry) ? entry : {};
    if (typeof p.name !== 'string' || p.name === '') {
      add('error', 'prompts.descriptor-invalid', 'Prompt needs a non-empty string name');
      continue;
    }
    if (names.has(p.name)) {
      add('error', 'prompts.duplicate-name', `Duplicate prompt name "${p.name}"`, p.name);
    }
    names.add(p.name);
    if ('arguments' in p && !Array.isArray(p.arguments)) {
      add('error', 'prompts.arguments-malformed', 'Prompt arguments must be an array', p.name);
    }
    out.push({
      name: clipText(p.name),
      fields: {
        ...(typeof p.description === 'string' ? { description: hashJson(p.description) } : {}),
        ...(Array.isArray(p.arguments) ? { arguments: hashJson(p.arguments) } : {}),
      },
    });
  }
  return out;
}

export { synthesizeSample };

// ---------- per-era run ----------

interface EraRunOptions {
  sampleCalls: McpSampleCallMode;
  maxPages: number;
  approved: Set<string>;
  secrets: readonly string[];
  signal?: AbortSignal;
}

function checkHandshake(era: McpEra, session: McpConformanceSession, add: Add) {
  const v = session.protocolVersion;
  if (!VERSION_RE.test(v)) {
    add(
      'error',
      'init.protocol-version',
      `Negotiated protocolVersion "${v}" is not a YYYY-MM-DD revision`
    );
  } else if (era === 'modern' && v < MCP_MODERN_ERA_FLOOR) {
    add(
      'warning',
      'init.era-mismatch',
      `Modern session negotiated ${v}, older than ${MCP_MODERN_ERA_FLOOR}`
    );
  } else if (era === 'legacy' && v >= MCP_MODERN_ERA_FLOOR) {
    add(
      'warning',
      'init.era-mismatch',
      `Legacy session negotiated ${v}, which is a modern-era revision`
    );
  }
  const info = session.serverInfo;
  const ok =
    isRecord(info) &&
    typeof info.name === 'string' &&
    info.name !== '' &&
    typeof info.version === 'string' &&
    info.version !== '';
  if (!ok)
    add('error', 'init.server-info', 'serverInfo must include non-empty string name and version');
}

async function runEra(
  era: McpEra,
  deps: McpConformanceDeps,
  opts: EraRunOptions
): Promise<McpEraResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const findings: McpConformanceFinding[] = [];
  let truncated = false;
  const add: Add = (severity, code, message, subject) => {
    if (findings.length >= MAX_FINDINGS) {
      if (!truncated) {
        truncated = true;
        findings.push({
          code: 'report.truncated',
          severity: 'warning',
          era,
          message: `More than ${MAX_FINDINGS} findings; the rest were dropped`,
        });
      }
      return;
    }
    findings.push({
      code,
      severity,
      era,
      message: sanitizeText(message, opts.secrets, MAX_ERROR_TEXT),
      ...(subject ? { subject: sanitizeText(subject, opts.secrets) } : {}),
    });
  };
  const result: McpEraResult = {
    era,
    status: 'ok',
    listing: { tools: [], resources: [], prompts: [] },
    samples: [],
    findings,
    durationMs: 0,
  };

  let session: McpConformanceSession;
  try {
    session = guardSession(await deps.open(era), opts.signal);
  } catch (err) {
    // A server that only speaks the other era is legitimate; only a legacy
    // failure (the baseline every client must support) is a violation.
    // Only a genuine negotiation refusal means "modern era unsupported"; a
    // timeout, network error, auth rejection or aborted run is a failure.
    const modern = era === 'modern' && !isNonNegotiationFailure(err, opts.signal);
    result.status = modern ? 'unsupported' : 'failed';
    result.error = sanitizeText(errMessage(err), opts.secrets, MAX_ERROR_TEXT);
    add(
      modern ? 'info' : 'error',
      modern ? 'era.unsupported' : 'era.connect-failed',
      modern
        ? `Server does not negotiate the modern (${MCP_MODERN_ERA_FLOOR}+) era: ${result.error}`
        : `Could not establish a legacy-era session: ${result.error}`
    );
    result.durationMs = now() - started;
    return result;
  }

  try {
    result.protocolVersion = sanitizeText(String(session.protocolVersion), opts.secrets, 40);
    checkHandshake(era, session, add);
    const info = session.serverInfo;
    const text = (v: string) => sanitizeText(v, opts.secrets);
    if (isRecord(info)) {
      result.serverInfo = {
        ...(typeof info.name === 'string' ? { name: text(info.name) } : {}),
        ...(typeof info.version === 'string' ? { version: text(info.version) } : {}),
        ...(typeof info.title === 'string' ? { title: text(info.title) } : {}),
      };
    }
    const caps = checkCapabilities(session.serverCapabilities, add);
    if (caps) result.capabilities = boundValue(caps, opts.secrets) as Record<string, unknown>;

    // Protocol hygiene: unknown methods must yield -32601 (Method not found).
    try {
      await session.request('restura/conformance-unknown-method');
      add(
        'warning',
        'protocol.unknown-method-accepted',
        'Server answered an unknown method with success instead of -32601'
      );
    } catch (err) {
      const code = errCode(err);
      if (code !== undefined && code !== -32601) {
        add(
          'info',
          'protocol.unknown-method-code',
          `Unknown method returned JSON-RPC code ${code}, expected -32601 (Method not found)`
        );
      }
    }

    // List only what the server advertised.
    const advertised = (k: string) => caps !== undefined && k in caps;
    let fullTools: McpToolDescriptor[] = [];
    if (advertised('tools')) {
      const raw = await listAll(session, 'tools/list', 'tools', opts.maxPages, add);
      if (raw) {
        fullTools = checkTools(raw, add);
        result.listing.tools = fullTools.map(snapshotTool);
      }
    }
    if (advertised('resources')) {
      const raw = await listAll(session, 'resources/list', 'resources', opts.maxPages, add);
      if (raw) result.listing.resources = checkResources(raw, add);
    }
    if (advertised('prompts')) {
      const raw = await listAll(session, 'prompts/list', 'prompts', opts.maxPages, add);
      if (raw) result.listing.prompts = checkPrompts(raw, add);
    }
    if (caps && !advertised('tools') && !advertised('resources') && !advertised('prompts')) {
      add('info', 'capabilities.empty', 'Server advertises no tools, resources or prompts');
    }

    const clean = (v: string) => sanitizeText(v, opts.secrets);
    const L = result.listing;
    L.tools = L.tools.map((t) => ({
      ...t,
      name: clean(t.name),
      ...(t.title ? { title: clean(t.title) } : {}),
    }));
    L.resources = L.resources.map((r) => ({
      uri: clean(r.uri),
      ...(r.name ? { name: clean(r.name) } : {}),
      ...(r.mimeType ? { mimeType: clean(r.mimeType) } : {}),
    }));
    L.prompts = L.prompts.map((p) => ({ ...p, name: clean(p.name) }));
    const samples = await runSamples(
      session,
      fullTools,
      { mode: opts.sampleCalls, approved: opts.approved },
      add,
      now
    );
    result.samples = samples.map((r) => ({
      ...r,
      tool: sanitizeText(r.tool, opts.secrets),
      ...(r.reason ? { reason: sanitizeText(r.reason, opts.secrets, MAX_ERROR_TEXT) } : {}),
    }));
  } finally {
    await session.close().catch(() => undefined);
    result.durationMs = now() - started;
  }
  return result;
}

export function summarizeFindings(findings: McpConformanceFinding[]) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

/** Run the scripted sequence for each requested era (sequentially) and assemble the report. */
export async function runMcpConformance(
  deps: McpConformanceDeps,
  options: McpConformanceOptions = {}
): Promise<McpConformanceReport> {
  const eras = options.eras ?? ['legacy', 'modern'];
  const sampleCalls = options.sampleCalls ?? 'off';
  const approvedTools = [...new Set(options.approvedTools ?? [])];
  const results: McpEraResult[] = [];
  for (const era of eras) {
    results.push(
      await runEra(era, deps, {
        sampleCalls,
        maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
        approved: new Set(approvedTools),
        secrets: options.secrets ?? [],
        ...(options.signal ? { signal: options.signal } : {}),
      })
    );
  }
  const diff = computeMcpEraDiff(results);
  const findings = [...results.flatMap((r) => r.findings), ...(diff?.findings ?? [])];
  if (findings.length > MAX_FINDINGS * 2) findings.length = MAX_FINDINGS * 2;
  return {
    schemaVersion: 1,
    generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    target: sanitizeText(redactConformanceTarget(options.target ?? ''), options.secrets ?? []),
    options: { sampleCalls, approvedTools },
    eras: results,
    diff: diff?.diff ?? null,
    findings,
    summary: summarizeFindings(findings),
  };
}
