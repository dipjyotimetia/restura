import { v4 as uuid } from 'uuid';
import { secretValueSchema } from '../secrets/secret-ref';
import type { McpStdioConfig, McpStdioEnvVar, McpTransportType } from '../types';

/**
 * OpenCollection carriage for the desktop-only MCP stdio launch config
 * (`x-restura-mcp[].mcp.stdio`). Import is shape-checked only: a collection
 * can describe a launch but can never approve it — consent is decided by the
 * Electron main process at connect time (ADR 0030).
 */

const MCP_TRANSPORTS: readonly McpTransportType[] = ['streamable-http', 'http-sse', 'stdio'];

export function mcpTransportFromOC(raw: unknown): McpTransportType {
  return MCP_TRANSPORTS.includes(raw as McpTransportType)
    ? (raw as McpTransportType)
    : 'streamable-http';
}

export function mcpStdioToOC(stdio: McpStdioConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { command: stdio.command, args: [...stdio.args] };
  if (stdio.cwd !== undefined) out.cwd = stdio.cwd;
  if (stdio.env?.length) {
    // Serialised verbatim, like headers. Credential redaction belongs to the
    // redaction layer (redactCollectionSecrets), which exports and the file
    // collection writer apply, honouring the export "include secrets" choice.
    out.env = stdio.env.map((e) => {
      const entry: Record<string, unknown> = { name: e.key, value: e.value };
      if (e.enabled === false) entry.enabled = false;
      if (e.description) entry.description = e.description;
      if (e.secret) entry.secret = true;
      if (e.secretRef !== undefined) entry.secretRef = e.secretRef;
      return entry;
    });
  }
  return out;
}

function envFromOC(raw: unknown): McpStdioEnvVar | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  const key = typeof e.name === 'string' ? e.name : typeof e.key === 'string' ? e.key : undefined;
  if (key === undefined) return undefined;
  const out: McpStdioEnvVar = {
    id: uuid(),
    key,
    value: typeof e.value === 'string' ? e.value : '',
    enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
  };
  if (typeof e.description === 'string') out.description = e.description;
  if (e.secret === true) out.secret = true;
  const ref = secretValueSchema.safeParse(e.secretRef);
  if (e.secretRef !== undefined && ref.success)
    out.secretRef = ref.data as McpStdioEnvVar['secretRef'];
  return out;
}

export function mcpStdioFromOC(raw: unknown): McpStdioConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.command !== 'string') return undefined;
  const out: McpStdioConfig = {
    command: s.command,
    args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : [],
  };
  if (typeof s.cwd === 'string') out.cwd = s.cwd;
  if (Array.isArray(s.env)) {
    const env = s.env.map(envFromOC).filter((e): e is McpStdioEnvVar => e !== undefined);
    if (env.length > 0) out.env = env;
  }
  return out;
}
