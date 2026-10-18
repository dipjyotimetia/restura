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
      ctx.warnings.push(
        `\${env:${name}} was not read from this machine; it maps to the Restura variable {{${name}}}`
      );
      return `{{${name}}}`;
    }
    ctx.warnings.push(`Placeholder ${sanitizeImportLabel(match, 60)} is not resolved`);
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
    ctx.warnings.push(`${what} must be an object and was ignored`);
    return [];
  }
  const out: ParsedMcpNameValue[] = [];
  for (const [name, value] of safeEntries(raw)) {
    if (out.length >= max) {
      ctx.warnings.push(`${what} limited to ${max} entries`);
      break;
    }
    const text = stringify(value);
    if (text === undefined) {
      ctx.warnings.push(
        `${what} "${sanitizeImportLabel(name, 60)}" is not a string and was skipped`
      );
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
  const warnings: string[] = [];
  const ctx: PlaceholderCtx = { warnings, inputsUsed };
  const name = sanitizeImportLabel(rawName) || `server-${index + 1}`;
  const base = { key: String(index), name, warnings };
  const invalid = (reason: string): ParsedMcpInvalidEntry => ({
    ...base,
    kind: 'invalid',
    disabled: false,
    reason,
  });
  if (!isPlainObject(raw)) return invalid('Entry is not an object');
  const disabled = raw.disabled === true || raw.enabled === false;

  const typeField = typeof raw.type === 'string' ? raw.type : undefined;
  const transportField = typeof raw.transport === 'string' ? raw.transport : undefined;
  const hasUrl = typeof raw.url === 'string' && raw.url !== '';
  const hasCommand = typeof raw.command === 'string' && raw.command !== '';
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
    const argsRaw = raw.args;
    let args: string[] = [];
    if (argsRaw !== undefined) {
      if (!Array.isArray(argsRaw)) return invalid('args must be an array of strings');
      if (argsRaw.length > MCP_IMPORT_LIMITS.maxArgs) {
        return invalid(`Too many arguments (max ${MCP_IMPORT_LIMITS.maxArgs})`);
      }
      const mapped = argsRaw.map(stringify);
      if (mapped.some((a) => a === undefined)) return invalid('args must be an array of strings');
      args = (mapped as string[]).map((a) => mapPlaceholders(a, ctx));
    }
    const entry: ParsedMcpStdioEntry = {
      ...base,
      kind: 'stdio',
      disabled,
      command: mapPlaceholders(raw.command as string, ctx),
      args,
      env: readNameValues(raw.env, 'env', MCP_IMPORT_LIMITS.maxEnvEntries, ctx),
    };
    if (typeof raw.cwd === 'string' && raw.cwd !== '') entry.cwd = mapPlaceholders(raw.cwd, ctx);
    if (raw.envFile !== undefined) {
      warnings.push('envFile is not imported; add its variables to the env table');
    }
    return entry;
  }

  const url = hasUrl ? mapPlaceholders(raw.url as string, ctx).trim() : '';
  if (!url) return invalid('HTTP entry has no url');
  if (!HTTP_URL.test(url)) return invalid('url must start with http:// or https://');
  return {
    ...base,
    kind: 'http',
    disabled,
    url,
    transport: kind,
    headers: readNameValues(raw.headers, 'headers', MCP_IMPORT_LIMITS.maxHeaders, ctx),
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
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id) continue;
    const input: ParsedMcpInput = {
      id: item.id.replace(SAFE_VAR, '_'),
      password: item.password === true,
    };
    if (typeof item.description === 'string') {
      input.description = sanitizeImportLabel(item.description, 120);
    }
    out.push(input);
  }
  return out;
}

/** Parse the text of an MCP client config. Throws McpConfigParseError for unusable input. */
export function parseMcpConfigText(text: string): ParsedMcpConfig {
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
  if ('mcpServers' in root) maps.push({ format: 'mcpServers', map: root.mcpServers });
  if ('servers' in root) maps.push({ format: 'vscode', map: root.servers });
  const mcpSection = root.mcp;
  if (isPlainObject(mcpSection) && 'servers' in mcpSection) {
    maps.push({ format: 'vscode-settings', map: mcpSection.servers });
  }
  if ('mcp.servers' in root) maps.push({ format: 'vscode-settings', map: root['mcp.servers'] });
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
  const inputs = readInputs(root.inputs, warnings);
  for (const id of inputsUsed) {
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
