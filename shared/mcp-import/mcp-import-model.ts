/**
 * Preview and draft shapes for the MCP config import (#906), plus the pure
 * conversions shared by the desktop (main-owned) and web (renderer-only)
 * paths. A preview never carries a value whose name looks like a credential;
 * a draft is what the renderer turns into saved `McpRequest`s.
 */

import { isSecretFieldName } from '../secrets/key-value-redaction';
import {
  MCP_IMPORT_LIMITS,
  type McpImportFormat,
  type McpImportTransport,
  type ParsedMcpEntry,
  type ParsedMcpHttpEntry,
  type ParsedMcpInput,
  type ParsedMcpNameValue,
} from './mcp-config-parser';

/** A `{{var}}`-only value is a reference, not a secret: it stays plain. */
export function isPlaceholderOnly(value: string): boolean {
  return /^\s*(\{\{[^{}]+\}\}\s*)+$/.test(value);
}

export interface McpImportPreviewRow {
  name: string;
  /** Omitted when the value is secret (never leaves main on desktop). */
  value?: string;
  secret: boolean;
}

export interface McpImportPreviewEntry {
  /** Selection key, unique within one scan session. */
  key: string;
  name: string;
  kind: 'stdio' | 'http' | 'invalid';
  disabled: boolean;
  warnings: string[];
  reason?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: McpImportPreviewRow[];
  url?: string;
  transport?: McpImportTransport;
  headers?: McpImportPreviewRow[];
}

export interface McpImportPreviewSource {
  /** Human label, e.g. "Claude Desktop". */
  label: string;
  /** Display-only location (home collapsed to ~). Never used to read anything. */
  location: string;
  formats: McpImportFormat[];
  entries: McpImportPreviewEntry[];
  inputs: ParsedMcpInput[];
  warnings: string[];
  error?: string;
}

export interface McpImportDraftRow {
  key: string;
  value: string;
  secret?: boolean;
  /** Present for handle-backed env values (desktop). */
  secretRef?: { kind: 'handle'; id: string; label?: string };
}

export interface McpImportDraft {
  name: string;
  transport: McpImportTransport | 'stdio';
  url: string;
  headers: McpImportDraftRow[];
  stdio?: { command: string; args: string[]; cwd?: string; env: McpImportDraftRow[] };
  warnings: string[];
}

const MAX_PREVIEW_WARNINGS = MCP_IMPORT_LIMITS.maxEntryWarnings + 1;
const URL_MASKED_WARNING =
  'The URL contains credentials. They are hidden in this preview and imported exactly as written.';
const ARGS_MASKED_WARNING =
  'Some arguments look like credentials. They are hidden in this preview and imported exactly as written.';
const MASK = '\u2022\u2022\u2022';
const FLAG = /^--?([A-Za-z][A-Za-z0-9_.-]*)(=(.*))?$/s;
const AUTH_LITERAL = /\b(Bearer|Basic)\s+[^\s"']+/gi;

function flagIsSecret(flag: string): boolean {
  return isSecretFieldName(flag) || isSecretFieldName(flag.replace(/-/g, '_'));
}

/**
 * Preview-only masking of credentials that sit in arguments: `--token value`,
 * `--token=value` for credential-named flags, and `Bearer x` / `Basic x`
 * literals. Imported values are NOT altered; this only keeps them off screen.
 */
export function maskArgsForPreview(args: readonly string[]): { args: string[]; masked: boolean } {
  let masked = false;
  const out: string[] = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      maskNext = false;
      out.push(MASK);
      masked = true;
      continue;
    }
    let text = arg;
    const m = FLAG.exec(arg);
    if (m?.[1] && flagIsSecret(m[1])) {
      if (m[2] !== undefined) {
        text = `${arg.slice(0, arg.indexOf('=') + 1)}${MASK}`;
        masked = true;
      } else {
        maskNext = true;
      }
    }
    const replaced = text.replace(AUTH_LITERAL, `$1 ${MASK}`);
    if (replaced !== text) masked = true;
    out.push(replaced);
  }
  return { args: out, masked };
}

/** Preview-only masking of URL userinfo and credential-named query parameters. */
export function maskUrlForPreview(url: string): { url: string; masked: boolean } {
  let masked = false;
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, (_m, scheme: string) => {
    masked = true;
    return `${scheme}${MASK}@`;
  });
  out = out.replace(
    /([?&;])([^=&#;]+)=([^&#;]*)/g,
    (m, sep: string, name: string, value: string) => {
      if (
        !isSecretFieldName(decodeURIComponentSafe(name)) ||
        value === '' ||
        isPlaceholderOnly(value)
      ) {
        return m;
      }
      masked = true;
      return `${sep}${name}=${MASK}`;
    }
  );
  return { url: out, masked };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Does this (header) row hold a credential the preview must hide? */
function rowIsSecret(row: ParsedMcpNameValue): boolean {
  return isSecretFieldName(row.name) && row.value !== '' && !isPlaceholderOnly(row.value);
}

/**
 * @param envIsHandleBacked decides which stdio env rows are hidden because
 *   main will store them as secret handles. The web path passes `() => false`
 *   (stdio is desktop-only there).
 */
export function toPreviewEntry(
  entry: ParsedMcpEntry,
  keyPrefix: string,
  envIsHandleBacked: (row: ParsedMcpNameValue) => boolean
): McpImportPreviewEntry {
  const base = {
    key: `${keyPrefix}${entry.key}`,
    name: entry.name,
    disabled: entry.disabled,
    // Parser output is already capped; slice again so any caller stays bounded.
    warnings: entry.warnings.slice(0, MAX_PREVIEW_WARNINGS),
  };
  if (entry.kind === 'invalid') return { ...base, kind: 'invalid', reason: entry.reason };
  if (entry.kind === 'http') {
    const url = maskUrlForPreview(entry.url);
    if (url.masked) base.warnings.push(URL_MASKED_WARNING);
    return {
      ...base,
      kind: 'http',
      url: url.url,
      transport: entry.transport,
      headers: entry.headers.map((h) =>
        rowIsSecret(h)
          ? { name: h.name, secret: true }
          : { name: h.name, value: h.value, secret: false }
      ),
    };
  }
  const args = maskArgsForPreview(entry.args);
  if (args.masked) base.warnings.push(ARGS_MASKED_WARNING);
  return {
    ...base,
    kind: 'stdio',
    command: entry.command,
    args: args.args,
    ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
    env: entry.env.map((e) =>
      envIsHandleBacked(e)
        ? { name: e.name, secret: true }
        : { name: e.name, value: e.value, secret: false }
    ),
  };
}

/**
 * HTTP entries need no secret store: headers persist as typed, exactly like
 * headers entered by hand, with the `secret` flag set for credential names so
 * export redaction and masking treat them consistently.
 */
export function buildHttpDraft(entry: ParsedMcpHttpEntry): McpImportDraft {
  return {
    name: entry.name,
    transport: entry.transport,
    url: entry.url,
    headers: entry.headers.map((h) => ({
      key: h.name,
      value: h.value,
      ...(isSecretFieldName(h.name) ? { secret: true } : {}),
    })),
    warnings: entry.warnings,
  };
}
