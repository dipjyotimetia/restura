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
import { validateAgainstSchema, validateToolOutput } from './mcp-output-schema';
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
}

export interface McpSampleCallRecord {
  tool: string;
  status: 'ok' | 'tool-error' | 'protocol-error' | 'skipped';
  reason?: string;
  durationMs?: number;
  outputSchema?: 'valid' | 'invalid' | 'missing' | 'no-schema';
}

export interface McpListingSnapshot {
  tools: McpToolDescriptor[];
  resources: Array<{ uri: string; name?: string; mimeType?: string }>;
  prompts: Array<{ name: string; description?: string; arguments?: unknown[] }>;
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
export const MCP_MODERN_ERA_FLOOR = '2026-07-28';
const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

type Add = (severity: McpFindingSeverity, code: string, message: string, subject?: string) => void;

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
    items.push(...arr);
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
      uri: r.uri,
      ...(typeof r.name === 'string' ? { name: r.name } : {}),
      ...(typeof r.mimeType === 'string' ? { mimeType: r.mimeType } : {}),
    });
  }
  return out;
}

function checkPrompts(raw: unknown[], add: Add): McpListingSnapshot['prompts'] {
  const out: McpListingSnapshot['prompts'] = [];
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
      name: p.name,
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      ...(Array.isArray(p.arguments) ? { arguments: p.arguments } : {}),
    });
  }
  return out;
}

// ---------- sample calls ----------

/** Minimal valid value for a JSON Schema, or `undefined` when we can't synthesize one. */
export function synthesizeSample(schema: unknown, depth = 0): unknown {
  if (!isRecord(schema) || depth > 4) return undefined;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('default' in schema) return schema.default;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string':
      return typeof schema.minLength === 'number' && schema.minLength > 0
        ? 'x'.repeat(Math.min(schema.minLength, 64))
        : '';
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      return [];
    case 'object':
    case undefined: {
      const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
      const props = isRecord(schema.properties) ? schema.properties : {};
      const obj: Record<string, unknown> = {};
      for (const key of required) {
        if (typeof key !== 'string') continue;
        const v = synthesizeSample(props[key], depth + 1);
        if (v === undefined) return undefined;
        obj[key] = v;
      }
      return obj;
    }
    default:
      return undefined;
  }
}

type SampleDecision = { call: true } | { call: false; reason: string };

function decideSample(
  tool: McpToolDescriptor,
  mode: McpSampleCallMode,
  approved: Set<string>
): SampleDecision {
  if (mode === 'off') return { call: false, reason: 'sample calls disabled' };
  const a = tool.annotations;
  if (a?.destructiveHint === true && a.readOnlyHint !== true) {
    return { call: false, reason: 'destructiveHint: never auto-invoked' };
  }
  if (a?.readOnlyHint === true) return { call: true };
  if (mode === 'selected' && approved.has(tool.name)) return { call: true };
  return { call: false, reason: 'not readOnlyHint and not explicitly approved' };
}

function hasTextBlock(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((c) => isRecord(c) && c.type === 'text' && typeof c.text === 'string')
  );
}

async function sampleOne(
  session: McpConformanceSession,
  tool: McpToolDescriptor,
  args: unknown,
  add: Add,
  now: () => number
): Promise<McpSampleCallRecord> {
  const start = now();
  try {
    const result = await session.request('tools/call', { name: tool.name, arguments: args });
    const durationMs = now() - start;
    if (!isRecord(result)) {
      add('error', 'tools.call-result-malformed', 'tools/call result must be an object', tool.name);
      return {
        tool: tool.name,
        status: 'protocol-error',
        durationMs,
        reason: 'result not an object',
      };
    }
    if (!Array.isArray(result.content) && result.structuredContent === undefined) {
      add(
        'error',
        'tools.call-content-missing',
        'tools/call result has neither a content array nor structuredContent',
        tool.name
      );
    }
    if (result.isError === true) {
      add('info', 'tools.sample-tool-error', 'Sample call returned isError: true', tool.name);
      return { tool: tool.name, status: 'tool-error', durationMs };
    }
    const validation = validateToolOutput(tool.outputSchema, result);
    if (validation.status === 'invalid' || validation.status === 'missing') {
      const code =
        validation.status === 'missing'
          ? 'tools.structured-content-missing'
          : 'tools.output-schema-mismatch';
      for (const issue of validation.issues) {
        add('error', code, `${issue.path}: ${issue.message}`, tool.name);
      }
    }
    if (result.structuredContent !== undefined && !hasTextBlock(result.content)) {
      add(
        'warning',
        'tools.structured-content-no-text',
        'structuredContent should also be serialized in a text content block for backward compatibility',
        tool.name
      );
    }
    if (result.structuredContent !== undefined && !tool.outputSchema) {
      add(
        'info',
        'tools.structured-content-no-schema',
        'Returned structuredContent without declaring an outputSchema',
        tool.name
      );
    }
    return { tool: tool.name, status: 'ok', durationMs, outputSchema: validation.status };
  } catch (err) {
    add('warning', 'tools.sample-failed', `Sample call failed: ${errMessage(err)}`, tool.name);
    return {
      tool: tool.name,
      status: 'protocol-error',
      durationMs: now() - start,
      reason: errMessage(err),
    };
  }
}

async function runSamples(
  session: McpConformanceSession,
  tools: McpToolDescriptor[],
  opts: { mode: McpSampleCallMode; approved: Set<string> },
  add: Add,
  now: () => number
): Promise<McpSampleCallRecord[]> {
  const records: McpSampleCallRecord[] = [];
  for (const tool of tools) {
    const decision = decideSample(tool, opts.mode, opts.approved);
    if (!decision.call) {
      records.push({ tool: tool.name, status: 'skipped', reason: decision.reason });
      if (tool.outputSchema && opts.mode !== 'off') {
        add(
          'info',
          'tools.output-schema-unverified',
          `outputSchema not verified: ${decision.reason}`,
          tool.name
        );
      }
      continue;
    }
    const args = synthesizeSample(tool.inputSchema ?? { type: 'object' });
    if (args === undefined || validateAgainstSchema(tool.inputSchema, args).length > 0) {
      records.push({
        tool: tool.name,
        status: 'skipped',
        reason: 'cannot synthesize valid arguments',
      });
      add(
        'info',
        'tools.sample-skipped',
        'Could not synthesize valid arguments; not called',
        tool.name
      );
      continue;
    }
    records.push(await sampleOne(session, tool, args, add, now));
  }
  return records;
}

// ---------- per-era run ----------

interface EraRunOptions {
  sampleCalls: McpSampleCallMode;
  maxPages: number;
  approved: Set<string>;
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
  const add: Add = (severity, code, message, subject) =>
    findings.push({ code, severity, era, message, ...(subject ? { subject } : {}) });
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
    session = await deps.open(era);
  } catch (err) {
    // A server that only speaks the other era is legitimate; only a legacy
    // failure (the baseline every client must support) is a violation.
    const modern = era === 'modern';
    result.status = modern ? 'unsupported' : 'failed';
    result.error = errMessage(err);
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
    result.protocolVersion = session.protocolVersion;
    checkHandshake(era, session, add);
    const info = session.serverInfo;
    if (isRecord(info)) {
      result.serverInfo = {
        ...(typeof info.name === 'string' ? { name: info.name } : {}),
        ...(typeof info.version === 'string' ? { version: info.version } : {}),
        ...(typeof info.title === 'string' ? { title: info.title } : {}),
      };
    }
    const caps = checkCapabilities(session.serverCapabilities, add);
    if (caps) result.capabilities = caps;

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
    if (advertised('tools')) {
      const raw = await listAll(session, 'tools/list', 'tools', opts.maxPages, add);
      if (raw) result.listing.tools = checkTools(raw, add);
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

    result.samples = await runSamples(
      session,
      result.listing.tools,
      { mode: opts.sampleCalls, approved: opts.approved },
      add,
      now
    );
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
      })
    );
  }
  const diff = computeMcpEraDiff(results);
  const findings = [...results.flatMap((r) => r.findings), ...(diff?.findings ?? [])];
  return {
    schemaVersion: 1,
    generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    target: redactConformanceTarget(options.target ?? ''),
    options: { sampleCalls, approvedTools },
    eras: results,
    diff: diff?.diff ?? null,
    findings,
    summary: summarizeFindings(findings),
  };
}
