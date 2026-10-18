/**
 * Preview and draft shapes for the MCP config import (#906), plus the pure
 * conversions shared by the desktop (main-owned) and web (renderer-only)
 * paths. A preview never carries a value whose name looks like a credential;
 * a draft is what the renderer turns into saved `McpRequest`s.
 */

import { isSecretFieldName } from '../secrets/key-value-redaction';
import type {
  McpImportFormat,
  McpImportTransport,
  ParsedMcpEntry,
  ParsedMcpHttpEntry,
  ParsedMcpInput,
  ParsedMcpNameValue,
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
    warnings: entry.warnings,
  };
  if (entry.kind === 'invalid') return { ...base, kind: 'invalid', reason: entry.reason };
  if (entry.kind === 'http') {
    return {
      ...base,
      kind: 'http',
      url: entry.url,
      transport: entry.transport,
      headers: entry.headers.map((h) =>
        rowIsSecret(h)
          ? { name: h.name, secret: true }
          : { name: h.name, value: h.value, secret: false }
      ),
    };
  }
  return {
    ...base,
    kind: 'stdio',
    command: entry.command,
    args: entry.args,
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
