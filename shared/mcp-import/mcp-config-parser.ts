/**
 * Pure parser for MCP client config files (#906): Claude Desktop
 * `claude_desktop_config.json` / Cursor `mcp.json` (`mcpServers`), VS Code
 * `mcp.json` (`servers` + `inputs`) and VS Code `settings.json`
 * (`mcp.servers`). Backend-agnostic: it only turns text into a bounded,
 * sanitised list of entries. It never touches the filesystem, never spawns
 * anything and never resolves `${env:...}` from the host process.
 */

import { type ParseError, parse as parseJsonc } from 'jsonc-parser';

export const MCP_IMPORT_LIMITS = {
  maxBytes: 1024 * 1024,
  maxServers: 200,
  maxNameLength: 100,
  maxArgs: 128,
  maxEnvEntries: 100,
  maxHeaders: 100,
  maxWarnings: 200,
  /** Per-entry warning cap; extra distinct warnings collapse into "and N more". */
  maxEntryWarnings: 10,
  /** Same bounds as the desktop `mcp:connect` stdio schema. */
  maxCommandLength: 4096,
  maxArgLength: 8192,
  maxArgsTotalLength: 64 * 1024,
  maxCwdLength: 4096,
  maxEnvNameLength: 256,
  maxValueLength: 32 * 1024,
  maxUrlLength: 8192,
} as const;

export type McpImportTransport = 'streamable-http' | 'http-sse';
export type McpImportFormat = 'mcpServers' | 'vscode' | 'vscode-settings';

export interface ParsedMcpNameValue {
  name: string;
  value: string;
}

interface ParsedEntryBase {
  /** Stable id within one parse (index based). */
  key: string;
  /** Sanitised display name derived from the map key. */
  name: string;
  disabled: boolean;
  warnings: string[];
}

export interface ParsedMcpStdioEntry extends ParsedEntryBase {
  kind: 'stdio';
  command: string;
  args: string[];
  cwd?: string;
  env: ParsedMcpNameValue[];
}

export interface ParsedMcpHttpEntry extends ParsedEntryBase {
  kind: 'http';
  url: string;
  transport: McpImportTransport;
  headers: ParsedMcpNameValue[];
}

export interface ParsedMcpInvalidEntry extends ParsedEntryBase {
  kind: 'invalid';
  reason: string;
}

export type ParsedMcpEntry = ParsedMcpStdioEntry | ParsedMcpHttpEntry | ParsedMcpInvalidEntry;

export interface ParsedMcpInput {
  id: string;
  description?: string;
  password: boolean;
}

export interface ParsedMcpConfig {
  formats: McpImportFormat[];
  entries: ParsedMcpEntry[];
  inputs: ParsedMcpInput[];
  warnings: string[];
}

export class McpConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigParseError';
  }
}

const SPOOFING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const SAFE_VAR = /[^A-Za-z0-9_.-]/g;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Strip Unicode Cc/Cf/Zl/Zp and clamp: names are shown in UI and used in handle labels. */
export function sanitizeImportLabel(
  raw: string,
  max: number = MCP_IMPORT_LIMITS.maxNameLength
): string {
  const cleaned = raw.replace(/\s+/g, ' ').replace(SPOOFING, '').trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own entries without prototype-polluting names. */
function safeEntries(obj: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(obj).filter(([name]) => !FORBIDDEN_KEYS.has(name));
}

interface PlaceholderCtx {
  warnings: string[];
  inputsUsed: Set<string>;
  /** Distinct warnings beyond the per-entry cap. */
  overflow: number;
}

/** Deduplicated, capped warning sink: untrusted input cannot flood the preview. */
function warn(ctx: PlaceholderCtx, message: string): void {
  if (ctx.warnings.includes(message)) return;
  if (ctx.warnings.length >= MCP_IMPORT_LIMITS.maxEntryWarnings) {
    ctx.overflow += 1;
    return;
  }
  ctx.warnings.push(message);
}

/** Own-property read: never walks the prototype chain. */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * VS Code `${input:id}` and `${env:NAME}` become Restura `{{vars}}`: the host
 * process environment is never read. Any other `${...}` is left literal and
 * reported.
 */
export function mapPlaceholders(text: string, ctx: PlaceholderCtx): string {
  return text.replace(/\$\{([^}]*)\}/g, (match, inner: string) => {
    const inputMatch = /^input:(.+)$/.exec(inner);
    if (inputMatch?.[1]) {
      const id = inputMatch[1].replace(SAFE_VAR, '_');
      ctx.inputsUsed.add(id);
      return `{{${id}}}`;
    }
    const envMatch = /^env:(.+)$/.exec(inner);
    if (envMatch?.[1]) {
      const name = envMatch[1].replace(SAFE_VAR, '_');
      warn(
        ctx,
        `\${env:${name}} was not read from this machine; it maps to the Restura variable {{${name}}}`
      );
      return `{{${name}}}`;
    }
    warn(ctx, `Placeholder ${sanitizeImportLabel(match, 60)} is not resolved`);
    return match;
  });
}

function stringify(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function readNameValues(
  raw: unknown,
  what: string,
  max: number,
  ctx: PlaceholderCtx
): ParsedMcpNameValue[] {
  if (raw === undefined || raw === null) return [];
  if (!isPlainObject(raw)) {
    warn(ctx, `${what} must be an object and was ignored`);
    return [];
  }
  const out: ParsedMcpNameValue[] = [];
  for (const [name, value] of safeEntries(raw)) {
    if (out.length >= max) {
      warn(ctx, `${what} limited to ${max} entries`);
      break;
    }
    const text = stringify(value);
    if (
      name.length > MCP_IMPORT_LIMITS.maxEnvNameLength ||
      (text?.length ?? 0) > MCP_IMPORT_LIMITS.maxValueLength
    ) {
      warn(ctx, `${what} "${sanitizeImportLabel(name, 60)}" is too long and was skipped`);
      continue;
    }
    if (text === undefined) {
      warn(ctx, `${what} "${sanitizeImportLabel(name, 60)}" is not a string and was skipped`);
      continue;
    }
    out.push({ name, value: mapPlaceholders(text, ctx) });
  }
  return out;
}

function mapTransport(type: string | undefined): McpImportTransport | 'stdio' | 'unknown' {
  switch (type?.toLowerCase()) {
    case undefined:
      return 'streamable-http';
    case 'stdio':
      return 'stdio';
    case 'sse':
    case 'http-sse':
      return 'http-sse';
    case 'http':
    case 'streamable-http':
    case 'streamablehttp':
      return 'streamable-http';
    default:
      return 'unknown';
  }
}

const HTTP_URL = /^(https?:\/\/|\{\{)/i;

function parseEntry(
  index: number,
  rawName: string,
  raw: unknown,
  inputsUsed: Set<string>
): ParsedMcpEntry {
  const ctx: PlaceholderCtx = { warnings: [], inputsUsed, overflow: 0 };
  const entry = parseEntryInner(index, rawName, raw, ctx);
  if (ctx.overflow > 0) entry.warnings.push(`and ${ctx.overflow} more warnings`);
  return entry;
}

function parseEntryInner(
  index: number,
  rawName: string,
  raw: unknown,
  ctx: PlaceholderCtx
): ParsedMcpEntry {
  const name = sanitizeImportLabel(rawName) || `server-${index + 1}`;
  const base = { key: String(index), name, warnings: ctx.warnings };
  const invalid = (reason: string): ParsedMcpInvalidEntry => ({
    ...base,
    kind: 'invalid',
    disabled: false,
    reason,
  });
  if (!isPlainObject(raw)) return invalid('Entry is not an object');
  const disabled = own(raw, 'disabled') === true || own(raw, 'enabled') === false;

  const rawType = own(raw, 'type');
  const rawTransport = own(raw, 'transport');
  const rawUrl = own(raw, 'url');
  const rawCommand = own(raw, 'command');
  const typeField = typeof rawType === 'string' ? rawType : undefined;
  const transportField = typeof rawTransport === 'string' ? rawTransport : undefined;
  const hasUrl = typeof rawUrl === 'string' && rawUrl !== '';
  const hasCommand = typeof rawCommand === 'string' && rawCommand !== '';
  let kind = mapTransport(typeField ?? transportField);
  if (typeField === undefined && transportField === undefined) {
    kind = hasCommand && !hasUrl ? 'stdio' : 'streamable-http';
  }
  if (kind === 'unknown') {
    return invalid(
      `Unsupported server type "${sanitizeImportLabel(String(typeField ?? transportField), 40)}"`
    );
  }

  if (kind === 'stdio') {
    if (!hasCommand) return invalid('stdio entry has no command');
    if ((rawCommand as string).length > MCP_IMPORT_LIMITS.maxCommandLength) {
      return invalid('command is too long');
    }
    const argsRaw = own(raw, 'args');
    let args: string[] = [];
    if (argsRaw !== undefined) {
      if (!Array.isArray(argsRaw)) return invalid('args must be an array of strings');
      if (argsRaw.length > MCP_IMPORT_LIMITS.maxArgs) {
        return invalid(`Too many arguments (max ${MCP_IMPORT_LIMITS.maxArgs})`);
      }
      const mapped = argsRaw.map(stringify);
      if (mapped.some((a) => a === undefined)) return invalid('args must be an array of strings');
      const texts = mapped as string[];
      if (
        texts.some((a) => a.length > MCP_IMPORT_LIMITS.maxArgLength) ||
        texts.reduce((n, a) => n + a.length, 0) > MCP_IMPORT_LIMITS.maxArgsTotalLength
      ) {
        return invalid('arguments are too long');
      }
      args = texts.map((a) => mapPlaceholders(a, ctx));
    }
    const rawCwd = own(raw, 'cwd');
    const entry: ParsedMcpStdioEntry = {
      ...base,
      kind: 'stdio',
      disabled,
      command: mapPlaceholders(rawCommand as string, ctx),
      args,
      env: readNameValues(own(raw, 'env'), 'env', MCP_IMPORT_LIMITS.maxEnvEntries, ctx),
    };
    if (typeof rawCwd === 'string' && rawCwd !== '') {
      if (rawCwd.length > MCP_IMPORT_LIMITS.maxCwdLength) {
        warn(ctx, 'Working directory is too long and was dropped');
      } else {
        entry.cwd = mapPlaceholders(rawCwd, ctx);
      }
    }
    if (own(raw, 'envFile') !== undefined) {
      warn(ctx, 'envFile is not imported; add its variables to the env table');
    }
    return entry;
  }

  if (hasUrl && (rawUrl as string).length > MCP_IMPORT_LIMITS.maxUrlLength) {
    return invalid('url is too long');
  }
  const url = hasUrl ? mapPlaceholders(rawUrl as string, ctx).trim() : '';
  if (!url) return invalid('HTTP entry has no url');
  if (!HTTP_URL.test(url)) return invalid('url must start with http:// or https://');
  return {
    ...base,
    kind: 'http',
    disabled,
    url,
    transport: kind,
    headers: readNameValues(own(raw, 'headers'), 'headers', MCP_IMPORT_LIMITS.maxHeaders, ctx),
  };
}

function readInputs(raw: unknown, warnings: string[]): ParsedMcpInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push('inputs must be an array and was ignored');
    return [];
  }
  const out: ParsedMcpInput[] = [];
  for (const item of raw.slice(0, 50)) {
    const id = isPlainObject(item) ? own(item, 'id') : undefined;
    if (!isPlainObject(item) || typeof id !== 'string' || !id) continue;
    const description = own(item, 'description');
    const input: ParsedMcpInput = {
      id: id.replace(SAFE_VAR, '_'),
      password: own(item, 'password') === true,
    };
    if (typeof description === 'string') {
      input.description = sanitizeImportLabel(description, 120);
    }
    out.push(input);
  }
  return out;
}

/**
 * Parse the text of an MCP client config. Throws McpConfigParseError for
 * unusable input; any unexpected failure (for example a RangeError on
 * pathological nesting) is reported with a generic message.
 */
export function parseMcpConfigText(text: string): ParsedMcpConfig {
  try {
    return parseMcpConfigTextUnsafe(text);
  } catch (err) {
    throw err instanceof McpConfigParseError
      ? err
      : new McpConfigParseError('Could not parse the config');
  }
}

function parseMcpConfigTextUnsafe(text: string): ParsedMcpConfig {
  if (new TextEncoder().encode(text).length > MCP_IMPORT_LIMITS.maxBytes) {
    throw new McpConfigParseError(
      `Config is larger than ${MCP_IMPORT_LIMITS.maxBytes / 1024} KB and was not read`
    );
  }
  const errors: ParseError[] = [];
  const root: unknown = parseJsonc(text.replace(/^﻿/, ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || root === undefined) {
    throw new McpConfigParseError('File is not valid JSON');
  }
  if (!isPlainObject(root)) throw new McpConfigParseError('Config must be a JSON object');

  const maps: Array<{ format: McpImportFormat; map: unknown }> = [];
  if (Object.hasOwn(root, 'mcpServers')) maps.push({ format: 'mcpServers', map: root.mcpServers });
  if (Object.hasOwn(root, 'servers')) maps.push({ format: 'vscode', map: root.servers });
  const mcpSection = own(root, 'mcp');
  if (isPlainObject(mcpSection) && Object.hasOwn(mcpSection, 'servers')) {
    maps.push({ format: 'vscode-settings', map: mcpSection.servers });
  }
  if (Object.hasOwn(root, 'mcp.servers')) {
    maps.push({ format: 'vscode-settings', map: root['mcp.servers'] });
  }
  if (maps.length === 0) {
    throw new McpConfigParseError(
      'No MCP servers found: expected a "mcpServers", "servers" or "mcp.servers" object'
    );
  }

  const warnings: string[] = [];
  const entries: ParsedMcpEntry[] = [];
  const inputsUsed = new Set<string>();
  const formats: McpImportFormat[] = [];
  let index = 0;
  for (const { format, map } of maps) {
    if (!isPlainObject(map)) {
      warnings.push(`The ${format} server list is not an object and was ignored`);
      continue;
    }
    formats.push(format);
    for (const [rawName, raw] of safeEntries(map)) {
      if (entries.length >= MCP_IMPORT_LIMITS.maxServers) {
        throw new McpConfigParseError(`More than ${MCP_IMPORT_LIMITS.maxServers} servers`);
      }
      entries.push(parseEntry(index++, rawName, raw, inputsUsed));
    }
  }
  const inputs = readInputs(own(root, 'inputs'), warnings);
  for (const id of inputsUsed) {
    if (warnings.length >= MCP_IMPORT_LIMITS.maxWarnings) break;
    if (!inputs.some((i) => i.id === id)) {
      warnings.push(`\${input:${id}} has no matching entry in "inputs"`);
    }
  }
  for (const input of inputs) {
    if (inputsUsed.has(input.id)) {
      warnings.push(
        `Input "${input.id}"${input.description ? ` (${input.description})` : ''} maps to the Restura variable {{${input.id}}}; define it in an environment`
      );
    }
  }
  return { formats, entries, inputs, warnings: warnings.slice(0, MCP_IMPORT_LIMITS.maxWarnings) };
}
